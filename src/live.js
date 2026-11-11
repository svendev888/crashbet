// Holds the round currently in progress, applies normalized events from the
// collector, broadcasts snapshots to dashboards and saves finished rounds.
//
// Normalized events (what every collector sends to POST /ingest):
//   { type: 'round_start',   gameId, at? }          betting opens (full round will be seen)
//   { type: 'round_join',    gameId }               joined mid-round (round marked partial)
//   { type: 'round_running', gameId }
//   { type: 'tick',          gameId, multiplier }
//   { type: 'bet',           gameId, betId?, playerId, name, amount, currency, usd,
//                            kind: 'classic'|'trenball', slot?, autoCashout?,   (classic)
//                            side?, condition?: {op:'>='|'<', x}, payout? }    (trenball)
//   { type: 'cashout',       gameId, betId?, playerId, multiplier }
//   { type: 'crashed',       gameId, crash }        shows the result immediately
//   { type: 'round_end',     gameId, crash, hash?, at? }   settles and saves the round
const { Round, Bet, Player } = require('./models');
const fairness = require('./fairness');

const r6 = (n) => Math.round(n * 1e6) / 1e6;
const LIVE_ROWS = 500;

function createLive(io) {
  let current = null;
  const recent = []; // last finished rounds, for the live ticker
  let dirty = false;

  function newRound(gameId, sawStart, at) {
    return {
      gameId: String(gameId),
      status: 'betting',
      sawStart,
      saved: false,
      startedAt: at ? new Date(at) : new Date(),
      multiplier: 1,
      crash: null,
      bets: new Map(),
    };
  }

  function roundFor(gameId) {
    if (gameId == null) {
      if (!current) current = newRound('unknown-' + Date.now(), false);
      return current;
    }
    if (!current || current.gameId !== String(gameId)) current = newRound(gameId, false);
    return current;
  }

  function findBet(r, ev) {
    if (ev.betId != null && r.bets.has(String(ev.betId))) return r.bets.get(String(ev.betId));
    if (ev.playerId == null) return null;
    for (const b of r.bets.values()) if (b.playerId === String(ev.playerId) && b.kind === 'classic' && b.cashedAt == null) return b;
    return null;
  }

  function settle(b, crash) {
    if (b.kind === 'trenball') {
      const c = b.condition || { op: '>=', x: 2 };
      b.won = c.op === '<' ? crash < c.x : crash >= c.x;
      b.profitUsd = r6(b.won ? b.usd * (b.payout - 1) : -b.usd);
      return;
    }
    if (b.cashedAt == null && b.autoCashout && b.autoCashout <= crash) b.cashedAt = b.autoCashout;
    b.won = b.cashedAt != null && b.cashedAt <= crash;
    if (b.won) b.payout = b.cashedAt;
    b.profitUsd = r6(b.won ? b.usd * (b.cashedAt - 1) : -b.usd);
  }

  async function finish(r, ev = {}) {
    if (r.saved) return;
    r.saved = true;
    r.status = 'ended';
    r.crash = Number(ev.crash ?? r.crash);
    r.multiplier = r.crash;
    if (ev.hash) r.hash = ev.hash;
    r.endedAt = ev.at ? new Date(ev.at) : r.endedAt || new Date();
    for (const b of r.bets.values()) settle(b, r.crash);
    const saved = await persist(r);
    if (saved) {
      recent.unshift({ gameId: saved.gameId, crash: saved.crash });
      if (recent.length > 50) recent.length = 50;
    }
    rememberFinished({ gameId: r.gameId, crash: r.crash, hash: r.hash });
  }

  // Last finished round + its provably-fair calculation, shown on the Live tab.
  let lastFinished = null;
  function rememberFinished(round) {
    const prev = lastFinished && Number(lastFinished.gameId) === Number(round.gameId) - 1 ? lastFinished.hash : null;
    lastFinished = { gameId: round.gameId, crash: round.crash, hash: round.hash, fairness: fairness.explain(round, prev) };
  }
  // On startup, seed from the newest saved round so the current round's commitment is known right away.
  Round.findOne({ hash: { $exists: true } }, { gameId: 1, crash: 1, hash: 1 }).sort({ endedAt: -1 }).lean()
    .then((r) => { if (r && !lastFinished) { rememberFinished(r); dirty = true; } })
    .catch(() => {});

  function fairSnapshot() {
    const cur = current;
    const commitment = cur && lastFinished && Number(lastFinished.gameId) === Number(cur.gameId) - 1 ? lastFinished.hash : null;
    return {
      salt: fairness.SALT,
      current: cur && cur.status !== 'ended' ? { gameId: cur.gameId, status: cur.status, crash: cur.crash, commitment } : null,
      last: lastFinished ? { gameId: lastFinished.gameId, crash: lastFinished.crash, ...lastFinished.fairness } : null,
    };
  }

  async function handle(ev) {
    switch (ev.type) {
      case 'round_start':
      case 'round_join': {
        // Previous round crashed but its settle message never came: save it now.
        if (current && current.crash != null && !current.saved && current.gameId !== String(ev.gameId)) await finish(current);
        if (ev.type === 'round_join' && current && current.gameId === String(ev.gameId)) break;
        current = newRound(ev.gameId, ev.type === 'round_start', ev.at);
        break;
      }
      case 'round_running':
        roundFor(ev.gameId).status = 'running';
        break;
      case 'tick': {
        const r = roundFor(ev.gameId);
        if (r.crash != null) break;
        r.status = 'running';
        r.multiplier = Number(ev.multiplier);
        // Show known auto cash-outs as soon as the multiplier passes them.
        for (const b of r.bets.values()) {
          if (b.kind === 'classic' && b.cashedAt == null && b.autoCashout && b.autoCashout <= r.multiplier) {
            b.cashedAt = b.autoCashout;
            b.profitUsd = r6(b.usd * (b.cashedAt - 1));
          }
        }
        break;
      }
      case 'bet': {
        const r = roundFor(ev.gameId);
        const playerId = String(ev.playerId ?? ev.name ?? 'hidden');
        const betId = String(ev.betId ?? `${playerId}:${ev.kind || 'classic'}:${ev.slot ?? 1}`);
        if (r.bets.has(betId)) break;
        const usd = Number(ev.usd ?? ev.amount) || 0;
        r.bets.set(betId, {
          betId,
          playerId,
          name: ev.name || playerId,
          kind: ev.kind || 'classic',
          slot: ev.slot ?? null,
          side: ev.side ?? null,
          condition: ev.condition ?? null,
          payout: ev.kind === 'trenball' ? Number(ev.payout) : null,
          amount: Number(ev.amount) || 0,
          currency: ev.currency || 'USD',
          usd,
          autoCashout: ev.autoCashout ? Number(ev.autoCashout) : null,
          cashedAt: null,
          won: null,
          profitUsd: null,
        });
        break;
      }
      case 'cashout': {
        const r = roundFor(ev.gameId);
        const b = findBet(r, ev);
        if (b) {
          b.cashedAt = Number(ev.multiplier);
          b.profitUsd = r6(b.usd * (b.cashedAt - 1));
        }
        break;
      }
      case 'crashed': {
        const r = roundFor(ev.gameId);
        r.crash = Number(ev.crash);
        r.multiplier = r.crash;
        r.status = 'crashed';
        r.endedAt = new Date();
        for (const b of r.bets.values()) settle(b, r.crash);
        break;
      }
      case 'round_end':
        await finish(roundFor(ev.gameId), ev);
        break;
      default:
        return;
    }
    dirty = true;
  }

  async function persist(r) {
    const bets = [...r.bets.values()];
    const at = r.endedAt;
    const sum = (arr, f) => r6(arr.reduce((s, b) => s + f(b), 0));
    const classic = bets.filter((b) => b.kind === 'classic');
    const tb = bets.filter((b) => b.kind === 'trenball');
    const wageredUsd = sum(bets, (b) => b.usd);
    const playersProfitUsd = sum(bets, (b) => b.profitUsd);
    const doc = {
      gameId: r.gameId,
      crash: r.crash,
      hash: r.hash,
      startedAt: r.startedAt,
      endedAt: at,
      partial: !r.sawStart,
      playerCount: new Set(bets.map((b) => b.playerId)).size,
      betCount: bets.length,
      classicBets: classic.length,
      trenballBets: tb.length,
      winners: bets.filter((b) => b.won).length,
      wageredUsd,
      classicWageredUsd: sum(classic, (b) => b.usd),
      trenballWageredUsd: sum(tb, (b) => b.usd),
      payoutUsd: r6(wageredUsd + playersProfitUsd),
      playersProfitUsd,
    };
    try {
      await Round.create(doc);
    } catch (e) {
      if (e.code === 11000) return null; // round already saved
      throw e;
    }
    if (bets.length) {
      await Bet.insertMany(bets.map((b) => ({ ...b, gameId: r.gameId, crash: r.crash, at })), { ordered: false });
      // One update per player per round (a player can have several bets in a round).
      const byPlayer = new Map();
      for (const b of bets) {
        const p = byPlayer.get(b.playerId) || { name: b.name, bets: 0, wins: 0, wagered: 0, profit: 0, classic: 0, trenball: 0, maxWin: 0, minLoss: 0, bestX: 0 };
        p.bets += 1;
        p.wins += b.won ? 1 : 0;
        p.wagered += b.usd;
        p.profit += b.profitUsd;
        p[b.kind] += 1;
        if (b.won) { p.maxWin = Math.max(p.maxWin, b.profitUsd); p.bestX = Math.max(p.bestX, b.payout || 0); }
        else p.minLoss = Math.min(p.minLoss, b.profitUsd);
        byPlayer.set(b.playerId, p);
      }
      await Player.bulkWrite([...byPlayer].map(([id, p]) => ({
        updateOne: {
          filter: { _id: id },
          upsert: true,
          update: {
            $set: { name: p.name, lastSeen: at },
            $setOnInsert: { firstSeen: at },
            $inc: {
              rounds: 1, bets: p.bets, wins: p.wins, losses: p.bets - p.wins,
              classicBets: p.classic, trenballBets: p.trenball,
              wageredUsd: r6(p.wagered), profitUsd: r6(p.profit),
            },
            $max: { biggestWinUsd: r6(p.maxWin), bestMultiplier: p.bestX },
            $min: { biggestLossUsd: r6(p.minLoss) },
          },
        },
      })), { ordered: false });
    }
    return doc;
  }

  function snapshot() {
    if (!current) return { round: null, recent, fair: fairSnapshot() };
    const r = current;
    const bets = [...r.bets.values()].sort((a, b) => b.usd - a.usd);
    return {
      round: {
        gameId: r.gameId,
        status: r.status,
        multiplier: r.multiplier,
        crash: r.crash,
        startedAt: r.startedAt,
        partial: !r.sawStart,
        players: new Set(bets.map((b) => b.playerId)).size,
        betCount: bets.length,
        wageredUsd: r6(bets.reduce((s, b) => s + b.usd, 0)),
        profitUsd: r6(bets.reduce((s, b) => s + (b.profitUsd ?? 0), 0)),
        cashedOut: bets.filter((b) => b.kind === 'classic' && b.cashedAt != null && b.won !== false).length,
        bets: bets.slice(0, LIVE_ROWS), // biggest bets only; totals above cover all
      },
      recent,
      fair: fairSnapshot(),
    };
  }

  setInterval(() => {
    if (!dirty) return;
    dirty = false;
    io.emit('live', snapshot());
  }, 500);

  return { handle, snapshot };
}

module.exports = { createLive };
