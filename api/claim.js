// POST /api/claim { owner, repo, destination }
// The signed-in GitHub user must be an admin of the repo. The server derives
// the repo's vault keypair, sweeps/collects its pump + PumpSwap creator fees
// and sends everything above the vault's rent floor to `destination`.
// DRY_RUN=1 -> simulate only and return the simulation.
'use strict';
const {
  ComputeBudgetProgram, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
} = require('@solana/web3.js');
const { OnlinePumpSdk, PUMP_SDK, getPumpProgram } = require('@pump-fun/pump-sdk');
const L = require('./_lib');
const { getLaunches } = require('./_registry');

const CU_LIMIT = 400_000, CU_PRICE = 50_000;

function compile(payer, blockhash, ixs) {
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
}

async function buildCollect(conn, vault, mints) {
  const ixs = [];
  // creator fees that v3 trades parked on each curve -> creator vault
  if (mints.length) {
    const infos = await conn.getMultipleAccountsInfo(mints.map(L.bondingCurve));
    for (let i = 0; i < mints.length; i++) {
      if (!infos[i]) continue;
      const c = PUMP_SDK.decodeBondingCurveNullable(infos[i]);
      if (!c || !c.creator.equals(vault) || !c.creatorFee || c.creatorFee.isZero()) continue;
      ixs.push(await PUMP_SDK.sweepCreatorFeeInstruction({ payer: vault, mint: mints[i], creator: vault, quoteMint: c.quoteMint }));
    }
  }
  const ammInfo = await conn.getAccountInfo(L.ammCreatorVaultWsolAta(vault));
  const ammHas = ammInfo && ammInfo.data.length >= 72 && ammInfo.data.readBigUInt64LE(64) > 0n;
  if (ammHas) {
    // pump collect + PumpSwap collect (wraps/unwraps WSOL itself, closes the ATA last)
    ixs.push(...await new OnlinePumpSdk(conn).collectCoinCreatorFeeInstructions(vault, vault));
  } else {
    ixs.push(await getPumpProgram(conn).methods.collectCreatorFee().accountsPartial({ creator: vault }).instruction());
  }
  return ixs;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') throw L.httpError(405, 'POST only');
    L.rateLimit(req, 'claim', 6, 60_000);
    const s = L.session(req);
    if (!s || !s.token) throw L.httpError(401, 'sign in with GitHub first');
    const b = await L.readBody(req, 5_000);
    const full = `${b.owner || ''}/${b.repo || ''}`;
    if (!L.REPO_RE.test(full)) throw L.httpError(400, 'bad repo');
    const dest = L.asPubkey(b.destination);
    if (!dest) throw L.httpError(400, 'bad destination wallet');

    const gh = await L.github('/repos/' + full, s.token);
    if (!gh.permissions || gh.permissions.admin !== true) throw L.httpError(403, `@${s.login} is not an admin of ${gh.full_name}`);
    const repoId = String(gh.id);
    const kp = L.vaultKeypair(repoId);
    const vault = kp.publicKey;
    if (dest.equals(vault)) throw L.httpError(400, 'destination cannot be the vault itself');

    const conn = L.connection();
    let mints = [];
    try { mints = (await getLaunches()).launches.filter((l) => l.repoId === repoId).map((l) => new PublicKey(l.mint)).slice(0, 12); }
    catch (_) { mints = []; } // registry unavailable: still collect the vaults

    const collect = await buildCollect(conn, vault, mints);
    const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE })];
    const { blockhash } = await conn.getLatestBlockhash('confirmed');

    // pass 1: simulate collection only, read the vault's balance afterwards
    const probe = compile(vault, blockhash, [...budget, ...collect]);
    const pre = await conn.getBalance(vault, 'confirmed');
    const sim1 = await conn.simulateTransaction(probe, {
      sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: 'base64', addresses: [vault.toBase58()] },
    });
    if (sim1.value.err) {
      if (pre < 10_000) throw L.httpError(409, `vault ${vault.toBase58()} has no SOL to pay the claim fee; send it 0.001 SOL and retry`);
      throw L.httpError(409, 'collect simulation failed: ' + JSON.stringify(sim1.value.err));
    }
    const after = sim1.value.accounts && sim1.value.accounts[0] ? sim1.value.accounts[0].lamports : pre;

    // pass 2: the real tx with the transfer, priced exactly
    const draft = compile(vault, blockhash, [...budget, ...collect, SystemProgram.transfer({ fromPubkey: vault, toPubkey: dest, lamports: 1 })]);
    const feeRes = await conn.getFeeForMessage(draft.message, 'confirmed');
    const fee = (feeRes && feeRes.value) || 5000 + Math.ceil((CU_LIMIT * CU_PRICE) / 1e6);
    const amount = after - fee - L.RENT_EXEMPT_0; // keep the vault rent-exempt for the next claim
    if (amount <= 0) throw L.httpError(409, 'nothing to claim yet');
    const tx = compile(vault, blockhash, [...budget, ...collect, SystemProgram.transfer({ fromPubkey: vault, toPubkey: dest, lamports: amount })]);
    tx.sign([kp]);

    if (process.env.DRY_RUN === '1') {
      const sim = await conn.simulateTransaction(tx, { sigVerify: true });
      return L.send(res, 200, {
        dryRun: true, repo: gh.full_name, vault: vault.toBase58(), destination: dest.toBase58(),
        lamports: amount, fee, err: sim.value.err, logs: (sim.value.logs || []).slice(-40), unitsConsumed: sim.value.unitsConsumed,
      });
    }
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
    L.send(res, 200, { dryRun: false, signature: sig, repo: gh.full_name, vault: vault.toBase58(), destination: dest.toBase58(), lamports: amount });
  } catch (e) { L.fail(res, e); }
};
