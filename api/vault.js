// GET /api/vault?id=<repoId>&mints=<m1,m2> -> the repo's vault + unclaimed fees.
// unclaimed = pump creator-vault lamports above rent
//           + creator fees v3 trades left on each launched curve (swept on claim)
//           + PumpSwap coin-creator vault WSOL (after migration)
'use strict';
const { PublicKey } = require('@solana/web3.js');
const { PUMP_SDK } = require('@pump-fun/pump-sdk');
const L = require('./_lib');

module.exports = async (req, res) => {
  try {
    L.rateLimit(req, 'vault', 60, 60_000);
    const url = new URL(req.url, 'http://x');
    const id = url.searchParams.get('id') || '';
    if (!/^\d{1,20}$/.test(id)) throw L.httpError(400, 'id must be a numeric GitHub repo id');
    const mints = (url.searchParams.get('mints') || '').split(',').filter(Boolean).slice(0, 20).map(L.asPubkey).filter(Boolean);

    const vault = L.vaultPubkey(id);
    const pumpVault = L.pumpCreatorVault(vault);
    const ammAta = L.ammCreatorVaultWsolAta(vault);
    const conn = L.connection();
    const keys = [vault, pumpVault, ammAta, ...mints.map(L.bondingCurve)];
    const [infos, rent0] = await Promise.all([
      conn.getMultipleAccountsInfo(keys),
      conn.getMinimumBalanceForRentExemption(0),
    ]);
    const vaultLamports = infos[0] ? infos[0].lamports : 0;
    const pumpLamports = infos[1] ? Math.max(0, infos[1].lamports - rent0) : 0;
    let ammLamports = 0;
    if (infos[2] && infos[2].data && infos[2].data.length >= 72) ammLamports = Number(infos[2].data.readBigUInt64LE(64));
    let curveLamports = 0;
    const coins = [];
    mints.forEach((m, i) => {
      const info = infos[3 + i];
      if (!info) return;
      try {
        const c = PUMP_SDK.decodeBondingCurveNullable(info);
        if (!c || !c.creator.equals(vault)) return;
        const fee = c.creatorFee ? Number(c.creatorFee.toString()) : 0;
        if (c.quoteMint.equals(PublicKey.default)) curveLamports += fee;
        coins.push({ mint: m.toBase58(), complete: !!c.complete, curveCreatorFee: fee });
      } catch (_) { /* ignore */ }
    });
    L.send(res, 200, {
      repoId: id, vault: vault.toBase58(), pumpCreatorVault: pumpVault.toBase58(), ammCreatorVaultAta: ammAta.toBase58(),
      vaultLamports, pumpLamports, curveLamports, ammLamports,
      unclaimedLamports: pumpLamports + curveLamports + ammLamports, coins,
    }, { 'cache-control': 'public, s-maxage=10, stale-while-revalidate=20' });
  } catch (e) { L.fail(res, e); }
};
