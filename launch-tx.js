// POST /api/launch-tx -> unsigned launch transaction(s) for the wallet to sign.
// body: { repoId, fullName, user, name, symbol, uri, devBuySol, treasury? }
'use strict';
const { Keypair } = require('@solana/web3.js');
const { OnlinePumpSdk } = require('@pump-fun/pump-sdk');
const L = require('./_lib');
const { buildLaunchTx, VAULT_SEED_LAMPORTS } = require('./_launch');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') throw L.httpError(405, 'POST only');
    L.rateLimit(req, 'launch-tx', 12, 60_000);
    const b = await L.readBody(req, 20_000);
    const treasury = L.treasury(b.treasury);
    if (!treasury) throw L.httpError(503, 'UPSTREAM_TREASURY is not set yet');
    const user = L.asPubkey(b.user);
    if (!user) throw L.httpError(400, 'bad wallet address');
    const repoId = String(b.repoId || '');
    if (!/^\d{1,20}$/.test(repoId)) throw L.httpError(400, 'bad repo id');
    let fullName = String(b.fullName || '');
    try { const gh = await L.github('/repositories/' + repoId); fullName = gh.full_name; } // trust GitHub over the client
    catch (e) { if (e.status === 404) throw e; /* rate limited: keep client value, id still decides the vault */ }
    if (!L.REPO_RE.test(fullName)) throw L.httpError(400, 'bad repo name');
    const uri = String(b.uri || '');
    if (!/^https:\/\/[^\s]{8,120}$/.test(uri)) throw L.httpError(400, 'bad metadata uri');
    const devBuyLamports = Math.round(Math.max(0, Number(b.devBuySol) || 0) * 1e9);

    const vault = L.vaultPubkey(repoId);
    const conn = L.connection();
    const sdk = new OnlinePumpSdk(conn);
    const [{ blockhash, lastValidBlockHeight }, vaultBal, global, feeConfig] = await Promise.all([
      conn.getLatestBlockhash('confirmed'),
      conn.getBalance(vault, 'confirmed'),
      devBuyLamports > 0 ? sdk.fetchGlobal() : null,
      devBuyLamports > 0 ? sdk.fetchFeeConfig().catch(() => null) : null,
    ]);
    const seedVault = vaultBal < L.RENT_EXEMPT_0 + 100_000;
    const mint = Keypair.generate();
    const txs = await buildLaunchTx({
      user, vault, mint: mint.publicKey, treasury, repoId, fullName,
      name: b.name, symbol: b.symbol, uri, devBuyLamports, seedVault, blockhash, global, feeConfig,
    });
    const ticket = L.seal({
      k: Buffer.from(mint.secretKey).toString('base64'), user: user.toBase58(), repoId, vault: vault.toBase58(),
      treasury: treasury.toBase58(), lvbh: lastValidBlockHeight, exp: Date.now() + 120_000,
    });
    L.send(res, 200, {
      txs: txs.map((t) => Buffer.from(t.serialize()).toString('base64')),
      mint: mint.publicKey.toBase58(), vault: vault.toBase58(), fullName, ticket,
      fees: { launchLamports: L.LAUNCH_FEE_LAMPORTS, vaultSeedLamports: seedVault ? VAULT_SEED_LAMPORTS : 0, devBuyLamports },
    });
  } catch (e) { L.fail(res, e); }
};
