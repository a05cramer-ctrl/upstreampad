// Pure transaction builder for an Upstream launch. No network access here:
// callers pass the blockhash and (for a dev buy) pump's Global + FeeConfig.
'use strict';
const BN = require('bn.js');
const {
  ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction, SystemProgram,
} = require('@solana/web3.js');
const { PUMP_SDK, getBuyTokenAmountFromSolAmount } = require('@pump-fun/pump-sdk');
const L = require('./_lib');

const MAX_DEV_BUY_LAMPORTS = 50 * 1e9;
const VAULT_SEED_LAMPORTS = 1_000_000; // 0.001 SOL, keeps the vault able to pay its own claim fee

function clean(s, max) { return String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max); }

/**
 * Returns [createTx] or [createTx, devBuyTx].
 * @param {object} p
 * @param {PublicKey} p.user          payer + signer (connected wallet)
 * @param {PublicKey} p.vault         repo vault pubkey -> pump `creator`
 * @param {PublicKey} p.mint          new mint pubkey (its keypair signs later)
 * @param {PublicKey} p.treasury      UPSTREAM_TREASURY
 * @param {string}    p.repoId, p.fullName, p.name, p.symbol, p.uri
 * @param {number}    p.devBuyLamports  0 for none
 * @param {boolean}   p.seedVault     add the 0.001 SOL rent seed to the vault
 * @param {string}    p.blockhash
 * @param {object}   [p.global] [p.feeConfig]  required when devBuyLamports > 0
 */
async function buildLaunchTx(p) {
  const name = clean(p.name, 32), symbol = clean(p.symbol, 10).toUpperCase(), uri = clean(p.uri, 120);
  if (!name || !symbol || !uri) throw L.httpError(400, 'name, symbol and uri are required');
  if (!L.REPO_RE.test(p.fullName)) throw L.httpError(400, 'bad repo name');
  if (!/^\d{1,20}$/.test(String(p.repoId))) throw L.httpError(400, 'bad repo id');
  const dev = Math.floor(Number(p.devBuyLamports) || 0);
  if (dev < 0 || dev > MAX_DEV_BUY_LAMPORTS) throw L.httpError(400, 'dev buy out of range');

  // create_v2 + 0.01 SOL fee + (vault seed) + memo  -> tx #1 (mint co-signs)
  // pump's create_v2 (16 accounts) + buy (18 accounts) no longer fit one
  // legacy-sized v0 message without a lookup table, so the optional dev buy
  // is tx #2, signed in the same wallet prompt and sent right after #1 lands.
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 }),
    await PUMP_SDK.createV2Instruction({
      mint: p.mint, name, symbol, uri, creator: p.vault, user: p.user, mayhemMode: false,
    }),
    L.feeTransferIx(p.user, p.treasury),
  ];
  if (p.seedVault) ixs.push(SystemProgram.transfer({ fromPubkey: p.user, toPubkey: p.vault, lamports: VAULT_SEED_LAMPORTS }));
  ixs.push(L.memoIx(L.launchMemo(p.repoId, p.fullName, p.mint.toBase58())));
  const out = [toTx(p, ixs)];

  if (dev > 0) {
    if (!p.global) throw L.httpError(500, 'pump global state missing');
    const solAmount = new BN(dev);
    const amount = getBuyTokenAmountFromSolAmount({
      global: p.global, feeConfig: p.feeConfig || null, mintSupply: null, bondingCurve: null, amount: solAmount,
    });
    const both = await PUMP_SDK.createV2AndBuyInstructions({
      global: p.global, mint: p.mint, name, symbol, uri, creator: p.vault, user: p.user,
      amount, solAmount, mayhemMode: false,
    });
    // drop the create (index 0): keep the user's token-2022 ATA + the first buy
    out.push(toTx(p, [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 }),
      ...both.slice(1),
    ]));
  }
  return out;
}

function toTx(p, ixs) {
  const msg = new TransactionMessage({ payerKey: p.user, recentBlockhash: p.blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  try { tx.serialize(); } catch (_) { throw L.httpError(400, 'transaction too large: shorten the name, ticker or description'); }
  return tx;
}

// Re-check a (wallet-signed) launch tx before the server adds the mint signature.
function verifyLaunchTx(tx, { mint, treasury, vault }) {
  const m = tx.message;
  const keys = m.staticAccountKeys;
  const payer = keys[0];
  let hasCreate = false, hasFee = false, hasMemo = false;
  for (const ix of m.compiledInstructions) {
    const prog = keys[ix.programIdIndex];
    const acc = ix.accountKeyIndexes.map((i) => keys[i]);
    if (prog.equals(L.PUMP_PROGRAM_ID) && acc[0] && acc[0].equals(mint)) {
      // create_v2 args: name, symbol, uri (borsh strings) then creator pubkey
      const d = Buffer.from(ix.data); let o = 8;
      for (let i = 0; i < 3; i++) { const n = d.readUInt32LE(o); o += 4 + n; }
      const creator = new PublicKey(d.subarray(o, o + 32));
      if (creator.equals(vault)) hasCreate = true;
    }
    if (prog.equals(SystemProgram.programId) && acc[1] && acc[1].equals(treasury)) {
      const d = Buffer.from(ix.data);
      if (d.readUInt32LE(0) === 2 && Number(d.readBigUInt64LE(4)) >= L.LAUNCH_FEE_LAMPORTS && acc[0].equals(payer)) hasFee = true;
    }
    if (prog.equals(L.MEMO_PROGRAM_ID) && Buffer.from(ix.data).toString('utf8').startsWith('UPSTREAM ')) hasMemo = true;
  }
  return { ok: hasCreate && hasFee && hasMemo, hasCreate, hasFee, hasMemo, payer };
}

module.exports = { buildLaunchTx, verifyLaunchTx, VAULT_SEED_LAMPORTS, MAX_DEV_BUY_LAMPORTS };
