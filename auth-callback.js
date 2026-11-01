// GET /api/auth-callback?code&state -> exchanges the code, stores a sealed,
// httpOnly session cookie { id, login, avatar, token }, returns to the repo page.
'use strict';
const L = require('./_lib');

module.exports = async (req, res) => {
  try {
    L.rateLimit(req, 'callback', 20, 60_000);
    const url = new URL(req.url, 'http://x');
    const code = url.searchParams.get('code'), state = url.searchParams.get('state');
    const st = L.unseal(L.cookies(req).up_state);
    if (!code || !st || st.state !== state) throw L.httpError(400, 'OAuth state mismatch: try again');
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID, client_secret: process.env.GITHUB_CLIENT_SECRET,
        code, redirect_uri: L.origin(req) + '/api/auth-callback',
      }),
    });
    const j = await r.json();
    if (!j.access_token) throw L.httpError(400, 'GitHub refused the code: ' + (j.error || r.status));
    const u = await L.github('/user', j.access_token);
    L.setCookie(res, 'up_state', '', 0);
    L.setCookie(res, 'up_session', L.seal({
      id: u.id, login: u.login, avatar: u.avatar_url, token: j.access_token, exp: Date.now() + 8 * 3600_000,
    }), 8 * 3600);
    res.statusCode = 302;
    res.setHeader('location', '/' + st.ret);
    res.end();
  } catch (e) {
    res.statusCode = 302;
    res.setHeader('location', '/#/?auth_error=' + encodeURIComponent(e.message || 'login failed'));
    res.end();
  }
};
