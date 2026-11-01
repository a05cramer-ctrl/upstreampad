// Shared server helpers for Upstream's Vercel functions.
// Files starting with "_" inside /api are not exposed as routes by Vercel.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction,
} = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } = require('@solana/spl-token');

const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const LAUNCH_FEE_LAMPORTS = 10_000_000; // 0.01 SOL platform fee -> treasury
const RENT_EXEMPT_0 = 890_880; // rent-exempt minimum for a 0-byte system account
const MEMO_RE = /UPSTREAM (\d{1,20}) ([A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100})(?: ([1-9A-HJ-NP-Za-km-z]{32,44}))?/;

// ---------- config ----------
let cfgCache = null;
function readConfig() {
  if (cfgCache) return cfgCache;
  const candidates = [path.join(__dirname, '..', 'config.js'), path.join(process.cwd(), 'config.js')];
  for (const f of candidates) {
    try {
      const src = fs.readFileSync(f, 'utf8');
      const sandbox = { window: {} };
      vm.runInNewContext(src, sandbox, { timeout: 50 });
      if (sandbox.window.UPSTREAM_CFG) { cfgCache = sandbox.window.UPSTREAM_CFG; return cfgCache; }
    } catch (_) { /* try next */ }
  }
  cfgCache = {};
  return cfgCache;
}

function asPubkey(s) {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return null;
  try { const k = new PublicKey(s); return k; } catch (_) { return null; }
}

// Treasury: config.js is the source of truth. The client may echo it as a hint
// (used only when config.js could not be read on the server).
function treasury(hint) {
  const c = readConfig();
  return asPubkey(c.UPSTREAM_TREASURY || '') || asPubkey(hint || '');
}

// ---------- vault derivation ----------
function vaultSeed(repoId, secret = process.env.VAULT_MASTER_SECRET) {
  if (!secret || secret.length < 32) throw httpError(500, 'VAULT_MASTER_SECRET missing or shorter than 32 chars');
  const id = String(repoId);
  if (!/^\d{1,20}$/.test(id)) throw httpError(400, 'bad repo id');
  return crypto.createHmac('sha256', secret).update('upstream:' + id).digest();
}
function vaultKeypair(repoId, secret) { return Keypair.fromSeed(vaultSeed(repoId, secret)); }
function vaultPubkey(repoId, secret) { return vaultKeypair(repoId, secret).publicKey; }

// ---------- PDAs ----------
function pumpCreatorVault(creator) {
  return PublicKey.findProgramAddressSync([Buffer.from('creator-vault'), creator.toBuffer()], PUMP_PROGRAM_ID)[0];
}
function ammCreatorVaultAuthority(creator) {
  return PublicKey.findProgramAddressSync([Buffer.from('creator_vault'), creator.toBuffer()], PUMP_AMM_PROGRAM_ID)[0];
}
function ammCreatorVaultWsolAta(creator) {
  return getAssociatedTokenAddressSync(NATIVE_MINT, ammCreatorVaultAuthority(creator), true, TOKEN_PROGRAM_ID);
}
function bondingCurve(mint) {
  return PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_PROGRAM_ID)[0];
}

// ---------- instructions ----------
function memoIx(text) {
  return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(text, 'utf8') });
}
function launchMemo(repoId, fullName, mint) {
  return `UPSTREAM ${repoId} ${fullName}${mint ? ' ' + mint : ''}`;
}
function parseMemo(memo) {
  if (!memo) return null;
  const m = MEMO_RE.exec(memo);
  if (!m) return null;
  return { repoId: m[1], repo: m[2], mint: m[3] || null };
}
function feeTransferIx(from, to, lamports = LAUNCH_FEE_LAMPORTS) {
  return SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });
}

// ---------- RPC ----------
function rpcUrl() {
  const k = process.env.HELIUS_API_KEY;
  if (!k) throw httpError(503, 'HELIUS_API_KEY not set');
  return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(k)}`;
}
let conn = null;
function connection() {
  if (!conn) conn = new Connection(rpcUrl(), { commitment: 'confirmed', disableRetryOnRateLimit: false });
  return conn;
}
async function rpc(method, params) {
  const r = await fetch(rpcUrl(), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (r.status === 429) throw httpError(429, 'RPC rate limited');
  const j = await r.json();
  if (j.error) throw httpError(502, 'RPC ' + method + ': ' + (j.error.message || 'error'));
  return j.result;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- HTTP helpers ----------
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}
function fail(res, e) {
  const status = e.status || 500;
  send(res, status, { error: status >= 500 && !e.status ? 'internal error' : e.message });
  if (!e.status) console.error(e);
}
async function readBody(req, limit = 3_000_000) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw httpError(413, 'body too large'); chunks.push(c); }
  const s = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(s || '{}'); } catch (_) { throw httpError(400, 'invalid JSON'); }
}

// naive per-instance rate limit
const hits = new Map();
function rateLimit(req, key, max, windowMs) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'x').split(',')[0].trim();
  const k = key + ':' + ip, now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) throw httpError(429, 'slow down');
  arr.push(now); hits.set(k, arr);
  if (hits.size > 5000) hits.clear();
}

// ---------- session cookie (AES-256-GCM sealed + HMAC key derivation) ----------
function sessionKeys() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw httpError(500, 'SESSION_SECRET missing or shorter than 32 chars');
  return {
    enc: crypto.createHmac('sha256', s).update('upstream:enc').digest(),
    mac: crypto.createHmac('sha256', s).update('upstream:mac').digest(),
  };
}
function seal(obj) {
  const { enc, mac } = sessionKeys();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', enc, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  const body = Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
  const sig = crypto.createHmac('sha256', mac).update(body).digest('base64url');
  return body + '.' + sig;
}
function unseal(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const { enc, mac } = sessionKeys();
  const [body, sig] = token.split('.');
  const want = crypto.createHmac('sha256', mac).update(body).digest();
  let got; try { got = Buffer.from(sig, 'base64url'); } catch (_) { return null; }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const raw = Buffer.from(body, 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', enc, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const obj = JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
    if (!obj.exp || obj.exp < Date.now()) return null;
    return obj;
  } catch (_) { return null; }
}
function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setCookie(res, name, value, maxAgeSec) {
  const prev = res.getHeader('set-cookie');
  const c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
  res.setHeader('set-cookie', prev ? [].concat(prev, c) : c);
}
function session(req) { return unseal(cookies(req).up_session); }

function origin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

const REPO_RE = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
async function github(pathname, token) {
  const r = await fetch('https://api.github.com' + pathname, {
    headers: {
      accept: 'application/vnd.github+json', 'user-agent': 'upstream-launchpad',
      'x-github-api-version': '2022-11-28', ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
  });
  if (r.status === 404) throw httpError(404, 'repo not found');
  if (!r.ok) throw httpError(r.status === 403 || r.status === 429 ? 429 : 502, 'GitHub API ' + r.status);
  return r.json();
}

module.exports = {
  PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, MEMO_PROGRAM_ID, LAUNCH_FEE_LAMPORTS, RENT_EXEMPT_0, REPO_RE,
  readConfig, asPubkey, treasury,
  vaultSeed, vaultKeypair, vaultPubkey,
  pumpCreatorVault, ammCreatorVaultAuthority, ammCreatorVaultWsolAta, bondingCurve,
  memoIx, launchMemo, parseMemo, feeTransferIx,
  rpcUrl, connection, rpc, sleep,
  httpError, send, fail, readBody, rateLimit,
  seal, unseal, cookies, setCookie, session, origin, github,
};
