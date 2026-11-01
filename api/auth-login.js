// GET /api/auth-login?return=#/r/owner/repo -> GitHub OAuth authorize
'use strict';
const crypto = require('crypto');
const L = require('./_lib');

module.exports = async (req, res) => {
  try {
    L.rateLimit(req, 'login', 20, 60_000);
    const id = process.env.GITHUB_CLIENT_ID;
    if (!id) throw L.httpError(503, 'GITHUB_CLIENT_ID not set');
    const url = new URL(req.url, 'http://x');
    let ret = url.searchParams.get('return') || '#/';
    if (!/^#\/[A-Za-z0-9_./-]{0,160}$/.test(ret)) ret = '#/';
    const state = crypto.randomBytes(16).toString('hex');
    L.setCookie(res, 'up_state', L.seal({ state, ret, exp: Date.now() + 600_000 }), 600);
    const q = new URLSearchParams({
      client_id: id, redirect_uri: L.origin(req) + '/api/auth-callback', state, allow_signup: 'false',
    });
    res.statusCode = 302;
    res.setHeader('location', 'https://github.com/login/oauth/authorize?' + q);
    res.end();
  } catch (e) { L.fail(res, e); }
};
