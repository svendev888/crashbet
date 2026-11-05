// Opens the BC.Game crash page in a real browser and listens to the page's own
// WebSocket traffic (and JSON API responses).
//
//   npm run capture   -> record raw frames to captures/*.jsonl (to learn the format)
//   npm run collect   -> parse frames with parser.js and send events to the server
//
// The browser profile is kept in .browser-profile/, so a login or captcha only
// has to be done once.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { parse } = require('./parser');
const { createPoster } = require('./post');

const CAPTURE = process.argv.includes('--capture');
const URL = process.env.BC_URL || 'https://bc.game/game/crash';
const ROOT = path.join(__dirname, '..');

let out = null;
if (CAPTURE) {
  fs.mkdirSync(path.join(ROOT, 'captures'), { recursive: true });
  const file = path.join(ROOT, 'captures', `frames-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  out = fs.createWriteStream(file);
  console.log('Capturing to', file);
}
const poster = CAPTURE ? null : createPoster();
let frames = 0;
let events = 0;

function onFrame(frame) {
  frames += 1;
  if (out) {
    out.write(JSON.stringify(frame) + '\n');
    return;
  }
  let evs = [];
  try {
    evs = parse(frame);
  } catch (e) {
    console.error('parser error:', e.message);
  }
  if (evs.length) {
    events += evs.length;
    poster.push(...evs);
  }
}

function toFrame(url, dir, payload) {
  const f = { t: Date.now(), url, dir };
  if (typeof payload === 'string') f.text = payload;
  else f.b64 = Buffer.from(payload).toString('base64');
  return f;
}

function watch(page) {
  page.on('websocket', (ws) => {
    console.log('WebSocket opened:', ws.url());
    ws.on('framereceived', (f) => onFrame(toFrame(ws.url(), 'in', f.payload)));
    ws.on('framesent', (f) => onFrame(toFrame(ws.url(), 'out', f.payload)));
    ws.on('close', () => console.log('WebSocket closed:', ws.url()));
  });
  page.on('response', async (res) => {
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('json') || !/bc\.game|bcgame/i.test(res.url())) return;
    try {
      onFrame({ t: Date.now(), url: res.url(), dir: 'http', text: await res.text() });
    } catch {
      /* body not available (redirect etc.) */
    }
  });
}

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(ROOT, '.browser-profile'), {
    headless: false,
    channel: process.env.BROWSER_CHANNEL || undefined,
    viewport: null,
  });
  ctx.pages().forEach(watch);
  ctx.on('page', watch);
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  console.log(CAPTURE
    ? 'Recording. Let it run for a few rounds (2-3 minutes), then press Ctrl+C.'
    : 'Collecting. Keep the browser window open.');

  // Keep USD prices fresh: the page's own fetch is picked up by the 'response' listener.
  const refreshPrices = () => page
    .evaluate(() => fetch('/api/game/support/system/conf/usdPrice').then((r) => r.ok))
    .catch((e) => console.error('price refresh failed:', e.message));
  setTimeout(refreshPrices, 3000);
  setInterval(refreshPrices, 5 * 60 * 1000);

  setInterval(() => console.log(`frames: ${frames}${CAPTURE ? '' : `, events sent: ${events}`}`), 10000);
  ctx.on('close', () => process.exit(0));
  process.on('SIGINT', async () => {
    if (out) out.end();
    await ctx.close().catch(() => {});
    process.exit(0);
  });
})().catch((e) => {
  console.error(e.message);
  if (/Chromium distribution|Executable doesn't exist/i.test(e.message)) {
    console.error('\nNo browser found. Either install Google Chrome and set BROWSER_CHANNEL=chrome in .env,\nor run: npx playwright install chromium   (and leave BROWSER_CHANNEL empty)');
  }
  process.exit(1);
});
