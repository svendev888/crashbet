// Copy-bets one player on BC.Game Crash (Classic) from your own logged-in browser.
//
//   npm run copybot
//
// How it works: the page's own WebSocket feed (decoded by parser.js) shows every
// player's bets and cash-outs live. When COPY_PLAYER_ID places a Classic bet
// while betting is open, the bot clicks Bet with your fixed COPY_STAKE. When that
// player cashes out, the bot clicks Cash out. Other players' auto cash-out
// targets are not in the feed, so the cash-out always follows theirs a moment
// later; if the round crashes in that gap, your bet busts.
//
// Login: the browser profile lives in .bot-profile/. Open the bot's window once
// (over VNC on a server), sign in, and the session stays saved there.
//
// Safety: COPY_DRY_RUN=1 logs what it would click without betting. Bets stop for
// the day once losses reach COPY_MAX_DAILY_LOSS (UTC day). Creating a file named
// .copybot-stop in the project folder pauses all betting immediately.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { parse } = require('./parser');

const ROOT = path.join(__dirname, '..');
const URL = process.env.BC_URL || 'https://bc.game/game/crash';
const env = (k, d) => (process.env[k] == null || process.env[k] === '' ? d : process.env[k]);
const CFG = {
  player: String(env('COPY_PLAYER_ID', '')),
  stake: Number(env('COPY_STAKE', 0)),
  autoCashout: Number(env('COPY_AUTO_CASHOUT', 1000)),
  maxDailyLoss: Number(env('COPY_MAX_DAILY_LOSS', 0)),
  dryRun: env('COPY_DRY_RUN', '1') !== '0',
  betRe: new RegExp(env('COPY_BTN_BET', '^bet$'), 'i'),
  cashRe: new RegExp(env('COPY_BTN_CASHOUT', 'cash ?out'), 'i'),
};
const STOP_FILE = path.join(ROOT, '.copybot-stop');
const LOG_FILE = path.join(ROOT, 'copybot-log.jsonl');

if (!CFG.player) fail('Set COPY_PLAYER_ID in .env (the player ID from the Best players tab).');
if (!(CFG.stake > 0)) fail('Set COPY_STAKE in .env: the amount per bet, in the currency selected in your BC.Game wallet.');
if (!(CFG.maxDailyLoss > 0)) fail('Set COPY_MAX_DAILY_LOSS in .env (same currency as COPY_STAKE).');
if (!(CFG.autoCashout > 1)) fail('COPY_AUTO_CASHOUT must be above 1.');
function fail(msg) { console.error(msg); process.exit(1); }

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const record = (o) => fs.appendFileSync(LOG_FILE, JSON.stringify({ t: new Date().toISOString(), dryRun: CFG.dryRun, ...o }) + '\n');

// ---------- state ----------
const round = { id: null, phase: 'unknown', multiplier: 1 };
let position = null; // { gameId, betId, stake, cashedAt?, settled? }
let day = new Date().toISOString().slice(0, 10);
// Today's real (not dry-run) P/L survives restarts: re-read it from the log.
function loadDailyPnl() {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((r) => !r.dryRun && String(r.t).slice(0, 10) === day)
      .reduce((sum, r) => sum + (Number(r.pnlEstimate) || 0), 0);
  } catch { return 0; }
}
let dailyPnl = loadDailyPnl();
let page = null;
let warnedLogin = false;
let skippedRound = null;

// UI actions run one at a time, in order.
let chain = Promise.resolve();
const ui = (fn) => { chain = chain.then(fn).catch((e) => log('UI error:', e.message)); return chain; };

function rollDay() {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== day) { day = d; dailyPnl = 0; log('New day: daily P/L reset.'); }
}

function blockedReason() {
  rollDay();
  if (fs.existsSync(STOP_FILE)) return 'paused (.copybot-stop exists)';
  // Stop before a bet that could take the day past the limit.
  if (dailyPnl - CFG.stake < -CFG.maxDailyLoss - 1e-9) return `daily loss limit reached (today ${dailyPnl.toFixed(8)})`;
  return null;
}

// ---------- page helpers ----------
// Finds the Classic bet panel from its stable "1/2" button and tags its parts.
async function tagPanel() {
  return page.evaluate(() => {
    const half = document.querySelector('#track-bet_amount_half');
    if (!half) return { ok: false, why: 'bet panel not found' };
    let panel = half;
    while (panel && !(panel.querySelectorAll('input[inputmode="decimal"]').length >= 2 && panel.querySelector('button.button-brand'))) panel = panel.parentElement;
    if (!panel) return { ok: false, why: 'bet panel inputs not found' };
    const [amount, auto] = panel.querySelectorAll('input[inputmode="decimal"]');
    const main = [...panel.querySelectorAll('button.button-brand')]
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
    amount.setAttribute('data-copybot', 'amount');
    auto.setAttribute('data-copybot', 'auto');
    main.setAttribute('data-copybot', 'main');
    const signIn = document.querySelector('#track-header_signin');
    const loggedOut = !!signIn && signIn.getBoundingClientRect().width > 0;
    return { ok: true, loggedOut, amount: amount.value, auto: auto.value, main: main.innerText.trim() };
  });
}

const el = (name) => page.locator(`[data-copybot="${name}"]`);
const mainText = async () => (await el('main').innerText({ timeout: 1000 })).trim().split('\n')[0];

async function setField(name, value) {
  const loc = el(name);
  const want = String(value);
  if (Number(await loc.inputValue()) === Number(want)) return true;
  await loc.fill(want);
  await loc.press('Tab');
  const got = await loc.inputValue();
  if (Number(got) !== Number(want)) { log(`Could not set ${name} to ${want} (field shows ${got}).`); return false; }
  return true;
}

// Before each round: make sure we're logged in, on Manual, with stake and auto cash-out set.
async function prepare(gameId) {
  const manual = page.locator('[data-track="bet_mode_tab"][data-track-item="manual"]');
  if (await manual.count() && (await manual.first().getAttribute('aria-selected')) !== 'true') await manual.first().click();
  const s = await tagPanel();
  if (!s.ok) { log(`Round ${gameId}: ${s.why}; skipping.`); return false; }
  if (s.loggedOut) {
    if (!warnedLogin) log('Not logged in. Open the bot browser (VNC) and sign in; betting starts after that.');
    warnedLogin = true;
    return false;
  }
  warnedLogin = false;
  const ok = (await setField('amount', CFG.stake)) && (await setField('auto', CFG.autoCashout));
  return ok;
}

// ---------- copy logic ----------
let prepared = null; // gameId the panel is ready for
let targetBets = {}; // gameId -> Set of the target's Classic bet IDs

function onEvent(ev) {
  switch (ev.type) {
    case 'round_start':
      round.id = ev.gameId; round.phase = 'betting'; round.multiplier = 1;
      prepared = null;
      targetBets = { [ev.gameId]: targetBets[ev.gameId] || new Set() };
      ui(async () => { if (await prepare(ev.gameId)) prepared = ev.gameId; });
      break;
    case 'round_join':
      round.id = ev.gameId; round.phase = 'unknown';
      break;
    case 'round_running':
      if (ev.gameId === round.id) round.phase = 'running';
      break;
    case 'tick':
      if (ev.gameId === round.id) { round.phase = 'running'; round.multiplier = ev.multiplier; }
      break;
    case 'bet':
      if (ev.playerId === CFG.player) {
        if (ev.kind === 'classic') (targetBets[ev.gameId] ||= new Set()).add(String(ev.betId));
        onTargetBet(ev);
      }
      break;
    case 'cashout': {
      if (ev.playerId !== CFG.player || !position || position.cashedAt || position.settled) break;
      // Match by bet ID; if the target has only one Classic bet this round, any of their cash-outs is it.
      const ids = targetBets[position.gameId];
      if (String(ev.betId) === String(position.betId) || (ids && ids.size === 1)) onTargetCashout(ev);
      break;
    }
    case 'crashed':
    case 'round_end':
      if (ev.gameId === round.id) round.phase = 'ended';
      if (position && position.gameId === ev.gameId && !position.settled && ev.crash != null) settle(ev.crash);
      break;
    default:
  }
}

function onTargetBet(ev) {
  if (ev.kind !== 'classic') { log(`Target placed a Trenball bet (${ev.side}); Trenball copying isn't supported yet.`); return; }
  if (position && position.gameId === ev.gameId) return; // already copying their first bet this round
  if (ev.gameId !== round.id || round.phase !== 'betting') { log(`Target bet on round ${ev.gameId} after betting closed; skipped.`); return; }
  const why = blockedReason();
  if (why) {
    if (skippedRound !== ev.gameId) log(`Target bet ${ev.amount} ${ev.currency}; not copying: ${why}.`);
    skippedRound = ev.gameId;
    return;
  }
  position = { gameId: ev.gameId, betId: ev.betId, stake: CFG.stake, theirs: `${ev.amount} ${ev.currency}` };
  const pos = position;
  ui(async () => {
    if (prepared !== ev.gameId && !(await prepare(ev.gameId))) { pos.settled = true; return; }
    prepared = ev.gameId;
    if (round.phase !== 'betting') { log('Betting closed before the click; skipped.'); pos.settled = true; return; }
    const text = await mainText();
    if (!CFG.betRe.test(text)) {
      log(`Main button says "${text}", which doesn't match COPY_BTN_BET (${CFG.betRe}); not clicking.`);
      pos.settled = true;
      return;
    }
    if (CFG.dryRun) {
      log(`[dry run] would click "${text}" for ${CFG.stake} (target bet ${pos.theirs}).`);
    } else {
      await el('main').click({ timeout: 1500 });
      log(`BET ${CFG.stake} on round ${ev.gameId} (target bet ${pos.theirs}). Button now: "${await mainText().catch(() => '?')}".`);
    }
    pos.placed = true;
  });
}

function onTargetCashout(ev) {
  const pos = position;
  ui(async () => {
    if (!pos.placed || pos.settled || pos.cashedAt) return;
    const text = await mainText();
    if (!CFG.cashRe.test(text)) {
      log(`Target cashed at ${ev.multiplier}x but main button says "${text}" (no match for COPY_BTN_CASHOUT ${CFG.cashRe}).`);
      return;
    }
    const at = round.multiplier;
    if (CFG.dryRun) log(`[dry run] would click "${text}" at ~${at}x (target cashed at ${ev.multiplier}x).`);
    else await el('main').click({ timeout: 1000 });
    pos.cashedAt = at;
    pos.targetCashedAt = ev.multiplier;
    if (!CFG.dryRun) log(`CASH OUT at ~${at}x (target cashed at ${ev.multiplier}x).`);
  });
}

function settle(crash) {
  const pos = position;
  ui(async () => {
    if (pos.settled) return;
    pos.settled = true;
    if (!pos.placed) return;
    let won = false;
    let x = null;
    if (pos.cashedAt && pos.cashedAt < crash) { won = true; x = pos.cashedAt; }
    else if (crash >= CFG.autoCashout) { won = true; x = CFG.autoCashout; }
    const pnl = won ? pos.stake * (x - 1) : -pos.stake;
    rollDay();
    if (!CFG.dryRun) dailyPnl += pnl;
    log(`Round ${pos.gameId} crashed at ${crash}x: ${won ? `won ~${pnl.toFixed(8)} at ~${x}x` : `lost ${pos.stake}`}` +
      `${pos.targetCashedAt ? ` (target cashed at ${pos.targetCashedAt}x)` : ' (target did not cash out)'}. Today: ${dailyPnl.toFixed(8)}.`);
    record({ gameId: pos.gameId, stake: pos.stake, crash, won, cashedAt: x, targetCashedAt: pos.targetCashedAt ?? null, pnlEstimate: pnl, dailyPnl });
    if (dailyPnl - CFG.stake < -CFG.maxDailyLoss - 1e-9) log('Daily loss limit reached; no more bets until 00:00 UTC.');
  });
}

// ---------- browser ----------
function onFrame(frame) {
  let evs = [];
  try { evs = parse(frame); } catch (e) { log('parser error:', e.message); }
  for (const ev of evs) onEvent(ev);
}

async function main() {
  log(`Copying player ${CFG.player}: stake ${CFG.stake}, auto cash-out ${CFG.autoCashout}x, daily loss limit ${CFG.maxDailyLoss} (today so far ${dailyPnl.toFixed(8)}).` +
    (CFG.dryRun ? ' DRY RUN: no real bets (set COPY_DRY_RUN=0 to bet).' : ' LIVE: real bets.'));
  const ctx = await chromium.launchPersistentContext(path.join(ROOT, '.bot-profile'), {
    headless: false,
    channel: process.env.BROWSER_CHANNEL || undefined,
    viewport: { width: 1400, height: 900 },
  });
  page = ctx.pages()[0] || (await ctx.newPage());
  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => onFrame({
      t: Date.now(), url: ws.url(), dir: 'in',
      ...(typeof f.payload === 'string' ? { text: f.payload } : { b64: Buffer.from(f.payload).toString('base64') }),
    }));
  });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.locator('#track-cookie_accept').click({ timeout: 8000 }).catch(() => {});
  log('Page open. Waiting for the next round.');
  ctx.on('close', () => process.exit(0));
  process.on('SIGINT', async () => { await ctx.close().catch(() => {}); process.exit(0); });
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
// For offline tests: drive the logic with a stand-in page.
module.exports = { onFrame, setPage: (p) => { page = p; }, idle: () => chain };
