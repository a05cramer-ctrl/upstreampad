// GET /api/me -> { login, id, avatar } of the GitHub session (never the token)
// POST /api/me { action: "logout" } -> clears it
'use strict';
const L = require('./_lib');

module.exports = async (req, res) => {
  try {
    if (req.method === 'POST') {
      L.setCookie(res, 'up_session', '', 0);
      return L.send(res, 200, { login: null });
    }
    let s = null;
    try { s = L.session(req); } catch (_) { s = null; }
    L.send(res, 200, s ? { login: s.login, id: s.id, avatar: s.avatar } : { login: null }, { 'cache-control': 'no-store' });
  } catch (e) { L.fail(res, e); }
};
