const express = require('express');
const { Round, Bet, Player } = require('./models');
const fairness = require('./fairness');
const { bestPlayers } = require('./best');

const clampInt = (v, def, min, max) => Math.min(max, Math.max(min, parseInt(v, 10) || def));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Only what the round detail view shows (keeps responses small over a remote DB).
const BET_FIELDS = { _id: 0, playerId: 1, name: 1, kind: 1, slot: 1, side: 1, payout: 1, amount: 1, currency: 1, usd: 1, cashedAt: 1, won: 1, profitUsd: 1 };
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

function createRoutes(live, ingestKey) {
  const r = express.Router();

  // Collector -> server. Events are applied in order.
  r.post('/ingest', wrap(async (req, res) => {
    if (req.get('x-ingest-key') !== ingestKey) return res.status(401).json({ error: 'bad ingest key' });
    const events = Array.isArray(req.body && req.body.events) ? req.body.events : [];
    for (const ev of events) await live.handle(ev);
    res.json({ ok: true, count: events.length });
  }));

  r.get('/api/live', (req, res) => res.json(live.snapshot()));

  // Round list, newest first. ?limit=&before=<ISO date>&minCrash=&maxCrash=
  r.get('/api/rounds', wrap(async (req, res) => {
    const limit = clampInt(req.query.limit, 50, 1, 500);
    const q = {};
    if (req.query.before) q.endedAt = { $lt: new Date(req.query.before) };
    if (req.query.minCrash || req.query.maxCrash) {
      q.crash = {};
      if (req.query.minCrash) q.crash.$gte = Number(req.query.minCrash);
      if (req.query.maxCrash) q.crash.$lt = Number(req.query.maxCrash);
    }
    const rows = await Round.find(q).sort({ endedAt: -1 }).limit(limit).lean();
    res.json(rows.map((row) => ({ ...row, fair: fairness.verified(row) })));
  }));

  r.get('/api/rounds/:gameId', wrap(async (req, res) => {
    const round = await Round.findOne({ gameId: req.params.gameId }).lean();
    if (!round) return res.status(404).json({ error: 'not found' });
    const [bets, prev] = await Promise.all([
      Bet.find({ gameId: req.params.gameId }, BET_FIELDS).sort({ usd: -1 }).limit(clampInt(req.query.bets, 100, 1, 100000)).lean(),
      Round.findOne({ gameId: String(Number(req.params.gameId) - 1) }, { hash: 1 }).lean(),
    ]);
    res.json({ round, bets, fairness: fairness.explain(round, prev && prev.hash) });
  }));

  // All-time player totals. ?sort=profitUsd&order=desc&limit=&skip=&q=<name>
  const SORTABLE = new Set(['profitUsd', 'wageredUsd', 'rounds', 'bets', 'wins', 'biggestWinUsd', 'biggestLossUsd', 'bestMultiplier', 'lastSeen', 'name']);
  r.get('/api/players', wrap(async (req, res) => {
    const sort = SORTABLE.has(req.query.sort) ? req.query.sort : 'profitUsd';
    const order = req.query.order === 'asc' ? 1 : -1;
    const limit = clampInt(req.query.limit, 50, 1, 500);
    const skip = clampInt(req.query.skip, 0, 0, 1e9);
    const q = req.query.q ? { name: new RegExp(escapeRe(String(req.query.q)), 'i') } : {};
    const [total, items] = await Promise.all([
      Player.countDocuments(q),
      Player.find(q).sort({ [sort]: order, _id: 1 }).skip(skip).limit(limit).lean(),
    ]);
    res.json({ total, items });
  }));

  // Players ranked by how far their profit sits above what luck explains.
  // ?days=7 (0 = all time) &minBets=50 &limit=100 &sort=z|profitUsd|roi|wageredUsd
  r.get('/api/players/best', wrap(async (req, res) => {
    const days = req.query.days === '0' ? 0 : clampInt(req.query.days, 7, 1, 3650);
    res.json(await bestPlayers({
      days,
      minBets: clampInt(req.query.minBets, 50, 1, 1e6),
      limit: clampInt(req.query.limit, 100, 1, 500),
      sort: String(req.query.sort || 'z'),
    }));
  }));

  r.get('/api/players/:id', wrap(async (req, res) => {
    const player = await Player.findById(req.params.id).lean();
    if (!player) return res.status(404).json({ error: 'not found' });
    const bets = await Bet.find({ playerId: req.params.id }).sort({ at: -1 }).limit(200).lean();
    res.json({ player, bets });
  }));

  // Compact series of the last N rounds, oldest first, for the Analysis charts.
  r.get('/api/analysis', wrap(async (req, res) => {
    const limit = clampInt(req.query.limit, 500, 10, 20000);
    const rows = await Round.find({}, {
      _id: 0, gameId: 1, crash: 1, endedAt: 1, wageredUsd: 1, playersProfitUsd: 1, betCount: 1, playerCount: 1, partial: 1,
    }).sort({ endedAt: -1 }).limit(limit).lean();
    res.json(rows.reverse());
  }));

  r.get('/api/stats', wrap(async (req, res) => {
    const [totals] = await Round.aggregate([{ $group: {
      _id: null,
      rounds: { $sum: 1 },
      avgCrash: { $avg: '$crash' },
      maxCrash: { $max: '$crash' },
      wageredUsd: { $sum: '$wageredUsd' },
      playersProfitUsd: { $sum: '$playersProfitUsd' },
      bets: { $sum: { $ifNull: ['$betCount', '$playerCount'] } },
      classicWageredUsd: { $sum: '$classicWageredUsd' },
      trenballWageredUsd: { $sum: '$trenballWageredUsd' },
      first: { $min: '$endedAt' },
      last: { $max: '$endedAt' },
    } }]);
    const buckets = await Round.aggregate([{ $bucket: {
      groupBy: '$crash',
      boundaries: [0, 1.01, 1.5, 2, 3, 5, 10, 100],
      default: '100+',
      output: { count: { $sum: 1 } },
    } }]);
    const players = await Player.estimatedDocumentCount();
    const under2 = await longestRunUnder(2, clampInt(req.query.runMin, 10, 2, 1000));
    res.json({ totals: totals || { rounds: 0 }, buckets, players, under2 });
  }));

  return r;
}

// Runs of consecutive rounds that crashed below `limit`, oldest to newest:
// the longest run, the current one, and the most recent runs of at least
// `minLen` rounds. A gap in game IDs (collector was offline) ends a run,
// since the missed rounds are unknown.
const RECENT_RUNS = 30;
async function longestRunUnder(limit, minLen = 10) {
  const cur = Round.find({ crash: { $ne: null } }, { _id: 0, gameId: 1, crash: 1, endedAt: 1 })
    .sort({ endedAt: 1 }).lean().cursor();
  let best = { length: 0 };
  let run = null;
  let prevId = null;
  let rounds = 0;
  let lastGameId = null;
  let longRuns = 0;
  const recent = [];
  const close = () => {
    if (run && run.length >= minLen) {
      longRuns++;
      recent.push(run);
      if (recent.length > RECENT_RUNS) recent.shift();
    }
    run = null;
  };
  for await (const r of cur) {
    const id = Number(r.gameId);
    if (run && !(id === prevId + 1)) close();
    prevId = id;
    rounds++;
    lastGameId = r.gameId;
    if (r.crash < limit) {
      if (!run) run = { length: 0, fromGameId: r.gameId, from: r.endedAt };
      run.length++;
      run.toGameId = r.gameId;
      run.to = r.endedAt;
      if (run.length > best.length) best = { ...run };
    } else {
      close();
    }
  }
  const current = run ? run.length : 0;
  if (run && run.length >= minLen) { run.ongoing = true; longRuns++; recent.push(run); }
  const ago = (g) => Number(lastGameId) - Number(g);
  return {
    limit,
    longest: best,
    current,
    minLen,
    rounds,
    longRuns,
    recent: recent.reverse().slice(0, RECENT_RUNS).map((x) => ({ ...x, roundsAgo: ago(x.toGameId) })),
  };
}

module.exports = { createRoutes, longestRunUnder };
