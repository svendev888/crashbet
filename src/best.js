// "Best players" ranking: profit judged against what luck alone would produce.
//
// Every crash bet has the same expected value whatever the target multiplier:
// -1% of the stake (house edge). What differs is the variance: a bet aiming at
// m wins with p = 0.99/m and pays m, so its profit has variance s^2 * m^2 * p(1-p).
// Summing over a player's bets gives the spread of results pure luck would
// produce, and the z-score says how many standard deviations their actual
// profit sits above the -1% expectation.
//
// The target is known for wins (cash-out point), Trenball (fixed payout) and
// classic bets with an auto cash-out. For classic bets lost while aiming to cash
// out by hand it's unknown; those use the player's average winning multiplier.
const { Bet } = require('./models');

const EDGE = 0.01;
const RTP = 1 - EDGE;

// Standard normal upper tail, P(Z > z). Abramowitz-Stegun 26.2.17, error < 7.5e-8.
function upperTail(z) {
  if (z < 0) return 1 - upperTail(-z);
  const t = 1 / (1 + 0.2316419 * z);
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI) * poly;
}

// Cornish-Fisher: a skewed sum's quantile is about w + g/6 (w^2 - 1) for normal
// quantile w. Invert to get the normal-equivalent score of an observed z, so a
// long-shot hunter's rare big win isn't rated rarer than it is.
function skewAdjust(z, skew) {
  const g = Math.min(Math.max(skew, 0), 3) / 6;
  if (g < 1e-6) return z;
  const disc = 1 + 4 * g * (z + g);
  if (disc <= 0) return -1 / (2 * g); // below the curve's turning point
  return (-1 + Math.sqrt(disc)) / (2 * g);
}

const cache = new Map();
const CACHE_MS = 60 * 1000;

async function bestPlayers({ days, minBets, limit, sort }) {
  const key = JSON.stringify([days, minBets, limit, sort]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const match = { won: { $ne: null }, playerId: { $ne: 'hidden' }, usd: { $gt: 0 } };
  if (days) match.at = { $gte: new Date(Date.now() - days * 86400000) };

  // Target multiplier m (null when unknown) and its win probability p.
  const target = {
    $cond: [
      { $or: ['$won', { $eq: ['$kind', 'trenball'] }] }, '$payout',
      { $ifNull: ['$autoCashout', null] },
    ],
  };
  const rows = await Bet.aggregate([
    { $match: match },
    { $addFields: { m: target } },
    { $addFields: { m: { $cond: [{ $gt: ['$m', 1] }, '$m', null] } } },
    { $addFields: {
      p: { $cond: ['$m', { $min: [RTP, { $divide: [RTP, '$m'] }] }, null] },
      s2: { $multiply: ['$usd', '$usd'] },
    } },
    { $group: {
      _id: '$playerId',
      name: { $last: '$name' },
      bets: { $sum: 1 },
      wins: { $sum: { $cond: ['$won', 1, 0] } },
      classic: { $sum: { $cond: [{ $eq: ['$kind', 'trenball'] }, 0, 1] } },
      wageredUsd: { $sum: '$usd' },
      profitUsd: { $sum: { $ifNull: ['$profitUsd', 0] } },
      maxBetUsd: { $max: '$usd' },
      knownVar: { $sum: { $cond: ['$m', { $multiply: ['$s2', '$m', '$m', '$p', { $subtract: [1, '$p'] }] }, 0] } },
      // Third central moment: s^3 m^3 p(1-p)(1-2p). High targets make results skewed.
      knownM3: { $sum: { $cond: ['$m', { $multiply: ['$s2', '$usd', '$m', '$m', '$m', '$p', { $subtract: [1, '$p'] }, { $subtract: [1, { $multiply: [2, '$p'] }] }] }, 0] } },
      unknownS2: { $sum: { $cond: ['$m', 0, '$s2'] } },
      unknownS3: { $sum: { $cond: ['$m', 0, { $multiply: ['$s2', '$usd'] }] } },
      expectedWins: { $sum: { $ifNull: ['$p', 0] } },
      targetSum: { $sum: { $ifNull: ['$m', 0] } },
      targetN: { $sum: { $cond: ['$m', 1, 0] } },
      winTargetSum: { $sum: { $cond: [{ $and: ['$won', '$m'] }, '$m', 0] } },
      firstSeen: { $min: '$at' },
      lastSeen: { $max: '$at' },
    } },
  ]);

  const total = rows.length;
  const items = [];
  for (const r of rows) {
    if (r.bets < minBets) continue;
    const mFill = r.wins ? Math.max(1.01, r.winTargetSum / r.wins) : 2;
    const pFill = Math.min(RTP, RTP / mFill);
    const variance = r.knownVar + r.unknownS2 * mFill * mFill * pFill * (1 - pFill);
    const expectedUsd = -EDGE * r.wageredUsd;
    const m3 = r.knownM3 + r.unknownS3 * mFill ** 3 * pFill * (1 - pFill) * (1 - 2 * pFill);
    const sd = Math.sqrt(variance);
    const rawZ = sd > 0 ? (r.profitUsd - expectedUsd) / sd : 0;
    const z = skewAdjust(rawZ, sd > 0 ? m3 / sd ** 3 : 0);
    const tail = upperTail(z);
    items.push({
      _id: r._id,
      name: r.name,
      bets: r.bets,
      wins: r.wins,
      classicBets: r.classic,
      trenballBets: r.bets - r.classic,
      wageredUsd: r.wageredUsd,
      profitUsd: r.profitUsd,
      expectedUsd,
      luckSdUsd: sd,
      z,
      rawZ,
      expectedWins: r.expectedWins + (r.bets - r.targetN) * pFill,
      oneIn: tail > 0 ? 1 / tail : Infinity,
      avgBetUsd: r.wageredUsd / r.bets,
      maxBetUsd: r.maxBetUsd,
      avgTarget: r.targetN ? r.targetSum / r.targetN : null,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
    });
  }
  const qualified = items.length;
  // With many players, some will look extraordinary by chance alone. Expected
  // number of qualified players reaching this z by luck: qualified * P(Z > z).
  for (const it of items) it.byChanceAmong = qualified / it.oneIn;

  const keyFn = {
    z: (a) => a.z,
    profitUsd: (a) => a.profitUsd,
    roi: (a) => a.profitUsd / a.wageredUsd,
    wageredUsd: (a) => a.wageredUsd,
  }[sort] || ((a) => a.z);
  items.sort((a, b) => keyFn(b) - keyFn(a));

  const data = { playersInPeriod: total, qualified, items: items.slice(0, limit) };
  if (cache.size > 50) cache.clear();
  cache.set(key, { at: Date.now(), data });
  return data;
}

module.exports = { bestPlayers, upperTail, skewAdjust };
