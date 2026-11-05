# Crash Analytics

Live per-player tracking for a crash game, with every round saved to MongoDB.

```
 BC.Game page (real browser)          simulator
        │ WebSocket frames                │
 collector/bcgame.js ─ parser.js ─┐       │
                                  ▼       ▼
                     POST /ingest  (normalized events)
                                  │
                         src/server.js ──► MongoDB (rounds, bets, players)
                                  │
                       Socket.IO + REST API
                                  │
                       Dashboard  http://localhost:3000
```

## Dashboard

- **Live**: current round, multiplier, and every player's bet, currency, USD value, auto cash-out, cash-out point and profit as it happens.
- **Rounds**: every saved round (crash point, players, winners, wagered, players' P/L). Filter by crash range; click a round to see all its bets.
- **Players**: all-time totals per player (rounds, win %, wagered, profit, ROI, biggest win/loss, best multiplier). Search and sort; click a player to see their bet history.
- **Stats**: totals, observed house edge, crash distribution.

## Setup

1. Install MongoDB: [MongoDB Community Server](https://www.mongodb.com/try/download/community) locally, or a free MongoDB Atlas cluster.
2. `copy .env.example .env` and set `MONGO_URI` and `INGEST_KEY`.
3. `npm install`
4. `npm start` → open http://localhost:3000

## Feeding data

**Simulator** (test the whole system with fake rounds):

```
npm run simulate
```

**BC.Game** (real data): the collector opens BC.Game in Chrome and decodes the page's own live traffic. No login is needed. Keep the browser window open.

```
npm run collect
```

The collector records:
- **Classic** bets: up to two per player per round (slot #1/#2). Every cash-out arrives as an event, auto and manual alike.
- **Trenball** bets: Red (<2x, pays 1.96x), Green (≥2x, 2x), Moon (≥10x, 10x), and a "<1.01x" bet. Trenball payouts are computed from the 1% edge, not read from the feed.
- The crash point, the round hash and the live multiplier.
- USD values, using BC.Game's own price list, which is refreshed every 5 minutes.

The live feed does **not** reveal a Classic bet's auto cash-out target before it triggers. A bet only shows as cashed out once the cash-out happens.

Other commands:

```
npm run capture     # record raw traffic to captures/ (for debugging protocol changes)
npm run analyze     # summarize a capture
npm run replay      # load a capture into the database as if live
```

The protocol was reverse-engineered on 2026-11-05 and is documented at the top of `collector/parser.js`. If BC.Game changes it, take a new capture and update that file.

The browser profile is stored in `.browser-profile/`. If you don't have Chrome, set `BROWSER_CHANNEL=` (empty) and run `npx playwright install chromium`.

## Event format (POST /ingest)

Header `x-ingest-key: <INGEST_KEY>`, body `{ "events": [ ... ] }`:

| type | fields |
|---|---|
| `round_start` | `gameId`, `at?` |
| `round_running` | `gameId` |
| `tick` | `gameId`, `multiplier` |
| `bet` | `gameId`, `playerId`, `name`, `amount`, `currency`, `usd`, `autoCashout?` |
| `cashout` | `gameId`, `playerId`, `multiplier` |
| `round_end` | `gameId`, `crash`, `hash?`, `at?` |

At `round_end`, bets are settled: a bet wins if it cashed out (manually, or by auto cash-out ≤ crash). Profit is `usd × (cashout − 1)`, or `−usd` on a bust. Rounds where the collector joined mid-round are flagged `partial`.

## MongoDB collections

- `rounds`: one per round (crash, hash, times, players, winners, wagered, payout, players' P/L)
- `bets`: one per player per round
- `players`: running totals per player, updated atomically at each round end

Hidden/anonymous players share whatever ID the parser gives them (e.g. `hidden`), so their totals are combined.

## API

`GET /api/live` · `GET /api/rounds?limit&before&minCrash&maxCrash` · `GET /api/rounds/:gameId` ·
`GET /api/players?sort&order&limit&skip&q` · `GET /api/players/:id` · `GET /api/stats`
