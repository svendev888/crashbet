// Fake crash game that feeds the server realistic data, so the dashboard and
// database can be tested without a live connection to BC.Game.
// Crash points follow P(crash >= x) = 0.99 / x (1% house edge).
const { createPoster } = require('./post');

const poster = createPoster();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const PLAYERS = Array.from({ length: 80 }, (_, i) => ({
  id: String(100000 + i * 7919),
  name: pick(['Lucky', 'Moon', 'Rocket', 'Whale', 'Degen', 'Satoshi', 'Ape', 'Hodl', 'Bull', 'Bear']) + (i + 1),
  bankroll: Math.exp(rand(0, 7)), // typical bet size: $1 .. ~$1100
  target: pick([1.2, 1.5, 2, 2, 3, 5, 10, null]),
}));

function crashPoint() {
  const r = Math.random();
  return Math.max(1, Math.floor(99 / (1 - r)) / 100);
}

let gameId = Math.floor(Date.now() / 1000);

async function round() {
  gameId += 1;
  const crash = crashPoint();
  poster.push({ type: 'round_start', gameId });

  // Betting phase: 5 seconds, players join at random times.
  const joined = PLAYERS.filter(() => Math.random() < 0.5);
  for (const p of joined) {
    const usd = Math.round(p.bankroll * rand(0.3, 1.5) * 100) / 100;
    poster.push({
      type: 'bet', gameId, playerId: p.id, name: p.name,
      amount: usd, currency: 'USDT', usd,
      autoCashout: p.target,
    });
    await sleep(5000 / joined.length);
  }

  // Running phase: multiplier grows exponentially until it hits the crash point.
  poster.push({ type: 'round_running', gameId });
  const manual = joined.filter((p) => !p.target).map((p) => ({ p, at: Math.max(1.01, Math.floor(rand(1, 4) * 100) / 100) }));
  const t0 = Date.now();
  for (;;) {
    const m = Math.floor(Math.exp(0.00015 * (Date.now() - t0)) * 100) / 100;
    if (m >= crash) break;
    poster.push({ type: 'tick', gameId, multiplier: m });
    for (const x of manual) {
      if (!x.done && m >= x.at) {
        x.done = true;
        poster.push({ type: 'cashout', gameId, playerId: x.p.id, multiplier: m });
      }
    }
    await sleep(100);
  }
  poster.push({ type: 'round_end', gameId, crash });
  console.log(`round ${gameId}: ${joined.length} players, crashed @ ${crash.toFixed(2)}x`);
  await sleep(3000);
}

(async () => {
  console.log('Simulator running. Ctrl+C to stop.');
  for (;;) await round();
})();
