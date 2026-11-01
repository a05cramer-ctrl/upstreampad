// GET /api/launches -> real launches read from the treasury's signatures.
'use strict';
const L = require('./_lib');
const { getLaunches } = require('./_registry');

module.exports = async (req, res) => {
  try {
    L.rateLimit(req, 'launches', 60, 60_000);
    const url = new URL(req.url, 'http://x');
    const data = await getLaunches(url.searchParams.get('treasury'));
    L.send(res, 200, data, { 'cache-control': 'public, s-maxage=20, stale-while-revalidate=40' });
  } catch (e) { L.fail(res, e); }
};
