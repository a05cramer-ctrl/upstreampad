// Launch registry: every Upstream launch pays the treasury and carries a memo
// "UPSTREAM <repoId> <owner/repo> <mint>". getSignaturesForAddress(treasury)
// returns each signature's memo directly, so no per-tx fetch is needed.
// Each launch is then verified on-chain: the mint's pump bonding curve must
// name the repo's vault as `creator`.
'use strict';
const { PublicKey } = require('@solana/web3.js');
const { PUMP_SDK, GLOBAL_PDA } = require('@pump-fun/pump-sdk');
const L = require('./_lib');

const TTL = 30_000;
let cache = null; // { key, at, data }
let inflight = null;
let globalCache = null; // { at, initialRealTokenReserves }

async function fetchSignatures(treasury) {
  const out = [];
  let before;
  for (let page = 0; page < 3; page++) {
    const opts = { limit: 1000, commitment: 'confirmed' };
    if (before) opts.before = before;
    const batch = await L.rpc('getSignaturesForAddress', [treasury.toBase58(), opts]);
    out.push(...batch);
    if (batch.length < 1000) break;
    before = batch[batch.length - 1].signature;
    await L.sleep(1000); // stay under Helius' free-tier burst limits
  }
  return out;
}

async function initialRealTokenReserves() {
  if (globalCache && Date.now() - globalCache.at < 600_000) return globalCache.v;
  try {
    const info = await L.connection().getAccountInfo(GLOBAL_PDA);
    const g = PUMP_SDK.decodeGlobal(info);
    globalCache = { at: Date.now(), v: BigInt(g.initialRealTokenReserves.toString()) };
  } catch (_) {
    globalCache = { at: Date.now(), v: 793_100_000_000_000n }; // pump default, used only for the progress bar
  }
  return globalCache.v;
}

async function curves(mints) {
  const conn = L.connection();
  const out = new Map();
  for (let i = 0; i < mints.length; i += 100) {
    if (i) await L.sleep(1000);
    const chunk = mints.slice(i, i + 100);
    const infos = await conn.getMultipleAccountsInfo(chunk.map((m) => L.bondingCurve(new PublicKey(m))));
    infos.forEach((info, j) => {
      if (!info) return;
      try { const c = PUMP_SDK.decodeBondingCurveNullable(info); if (c) out.set(chunk[j], c); } catch (_) { /* skip */ }
    });
  }
  return out;
}

async function assets(mints) {
  const out = new Map();
  for (let i = 0; i < mints.length; i += 100) {
    if (i) await L.sleep(1000);
    try {
      const res = await L.rpc('getAssetBatch', { ids: mints.slice(i, i + 100) });
      for (const a of res || []) {
        if (!a || !a.id) continue;
        const md = (a.content && a.content.metadata) || {};
        const img = (a.content && ((a.content.links && a.content.links.image) || (a.content.files && a.content.files[0] && a.content.files[0].uri))) || null;
        out.set(a.id, { name: md.name || null, symbol: md.symbol || null, image: img });
      }
    } catch (_) { /* metadata is decoration; launches still list without it */ }
  }
  return out;
}

async function build(treasury) {
  const sigs = await fetchSignatures(treasury);
  const seen = new Set();
  const raw = [];
  for (const s of sigs) {
    if (s.err) continue;
    const m = L.parseMemo(s.memo);
    if (!m || !m.mint || seen.has(m.mint)) continue;
    seen.add(m.mint);
    raw.push({ ...m, sig: s.signature, time: s.blockTime || null });
  }
  const mints = raw.map((r) => r.mint).slice(0, 300);
  const [cv, meta, irr] = await Promise.all([curves(mints), assets(mints), initialRealTokenReserves()]);
  const launches = [];
  const vaults = new Map();
  for (const r of raw) {
    const c = cv.get(r.mint);
    if (!c) continue;
    let v = vaults.get(r.repoId);
    if (!v) { v = L.vaultPubkey(r.repoId); vaults.set(r.repoId, v); }
    if (!c.creator.equals(v)) continue; // memo lies: curve creator is not this repo's vault
    const real = BigInt(c.realTokenReserves.toString());
    const progress = c.complete ? 1 : Math.max(0, Math.min(1, 1 - Number(real) / Number(irr)));
    const md = meta.get(r.mint) || {};
    launches.push({
      repoId: r.repoId, repo: r.repo, mint: r.mint, sig: r.sig, time: r.time, vault: v.toBase58(),
      name: md.name, symbol: md.symbol, image: md.image, complete: !!c.complete, progress,
    });
  }
  launches.sort((a, b) => (b.time || 0) - (a.time || 0));
  const repos = new Map();
  for (const l of launches) {
    const r = repos.get(l.repoId) || { repoId: l.repoId, repo: l.repo, count: 0, last: 0 };
    r.count++; r.last = Math.max(r.last, l.time || 0); repos.set(l.repoId, r);
  }
  return {
    treasury: treasury.toBase58(),
    launches: launches.slice(0, 200),
    repos: [...repos.values()].sort((a, b) => b.last - a.last).slice(0, 24),
    updated: Date.now(),
  };
}

async function getLaunches(treasuryHint) {
  const t = L.treasury(treasuryHint);
  if (!t) return { treasury: null, launches: [], repos: [], updated: Date.now() };
  const key = t.toBase58();
  if (cache && cache.key === key && Date.now() - cache.at < TTL) return cache.data;
  if (inflight && inflight.key === key) return inflight.p;
  const p = build(t).then((data) => { cache = { key, at: Date.now(), data }; return data; })
    .finally(() => { inflight = null; });
  inflight = { key, p };
  try { return await p; } catch (e) { if (cache && cache.key === key) return cache.data; throw e; }
}

module.exports = { getLaunches };
