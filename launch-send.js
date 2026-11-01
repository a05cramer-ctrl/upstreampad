// POST /api/launch-send { txs:[base64 wallet-signed], ticket } -> adds the mint
// signature to the create tx, re-verifies it, sends it, then the dev buy.
'use strict';
const { Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const L = require('./_lib');
const { verifyLaunchTx } = require('./_launch');

async function waitFor(conn, sig, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const { value } = await conn.getSignatureStatuses([sig]);
    const s = value[0];
    if (s && s.err) throw L.httpError(400, 'launch failed on-chain: ' + JSON.stringify(s.err));
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return true;
    await L.sleep(700);
  }
  return false;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') throw L.httpError(405, 'POST only');
    L.rateLimit(req, 'launch-send', 12, 60_000);
    const b = await L.readBody(req, 20_000);
    const t = L.unseal(b.ticket);
    if (!t) throw L.httpError(400, 'launch ticket expired: start again');
    if (!Array.isArray(b.txs) || !b.txs.length || b.txs.length > 2) throw L.httpError(400, 'txs missing');
    const mint = Keypair.fromSecretKey(Buffer.from(t.k, 'base64'));
    const user = new PublicKey(t.user);
    const txs = b.txs.map((s) => VersionedTransaction.deserialize(Buffer.from(String(s), 'base64')));
    const v = verifyLaunchTx(txs[0], { mint: mint.publicKey, treasury: new PublicKey(t.treasury), vault: new PublicKey(t.vault) });
    if (!v.ok || !v.payer.equals(user)) throw L.httpError(400, 'launch transaction failed verification');
    if (txs[1] && !txs[1].message.staticAccountKeys[0].equals(user)) throw L.httpError(400, 'dev buy payer mismatch');
    txs[0].sign([mint]);

    const conn = L.connection();
    const sig = await conn.sendRawTransaction(txs[0].serialize(), { skipPreflight: false, maxRetries: 5 });
    const landed = await waitFor(conn, sig, 25_000);
    let buySig = null, buyError = null;
    if (txs[1]) {
      if (!landed) buyError = 'create not confirmed in time; dev buy not sent';
      else {
        try { buySig = await conn.sendRawTransaction(txs[1].serialize(), { skipPreflight: false, maxRetries: 5 }); }
        catch (e) { buyError = String(e.message || e).slice(0, 300); }
      }
    }
    L.send(res, 200, { signature: sig, confirmed: landed, mint: mint.publicKey.toBase58(), buySignature: buySig, buyError });
  } catch (e) { L.fail(res, e); }
};
