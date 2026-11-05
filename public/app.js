const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const usd = (n) => (n == null ? '–' : (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pnl = (n) => (n == null ? '<span class="muted">–</span>' : `<span class="${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}">${n > 0 ? '+' : ''}${usd(n)}</span>`);
const x = (n) => (n == null ? '–' : Number(n).toFixed(2) + 'x');
const num = (n, d = 8) => (n == null ? '–' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d }));
const time = (d) => (d ? new Date(d).toLocaleString() : '–');
const roi = (profit, wagered) => {
  if (!wagered) return '–';
  const v = (profit / wagered) * 100;
  return `<span class="${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}">${v > 0 ? '+' : ''}${v.toFixed(1)}%</span>`;
};
const winPct = (p) => { const n = p.bets ?? p.rounds; return n ? ((p.wins / n) * 100).toFixed(1) + '%' : '–'; };
const chipCls = (c) => (c < 2 ? 'lo' : c < 10 ? 'mid' : 'hi');
const api = (path) => fetch(path).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });

// ---------- tabs ----------
const loaders = { rounds: () => loadRounds(true), players: () => loadPlayers(), stats: () => loadStats() };
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('nav button').forEach((n) => n.classList.toggle('active', n === b));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
  loaders[b.dataset.tab]?.();
}));

// ---------- live ----------
const socket = io();
socket.on('connect', () => { $('conn').textContent = 'live'; $('conn').className = 'pill on'; });
socket.on('disconnect', () => { $('conn').textContent = 'offline'; $('conn').className = 'pill off'; });
socket.on('live', renderLive);

function renderLive({ round, recent }) {
  $('recent').innerHTML = (recent || []).map((r) => `<span class="chip ${chipCls(r.crash)}" data-game="${esc(r.gameId)}">${x(r.crash)}</span>`).join('');
  if (!round) return;
  $('l-game').textContent = '#' + round.gameId;
  $('l-status').textContent = round.status + (round.partial ? ' (joined mid-round)' : '');
  const m = $('l-mult');
  m.textContent = round.status === 'betting' ? 'Betting…' : x(round.multiplier);
  m.className = 'mult ' + (round.status === 'crashed' ? 'ended' : round.status);
  $('l-players').textContent = `${round.players} (${round.betCount ?? round.bets.length} bets)`;
  $('l-wager').textContent = usd(round.wageredUsd);
  $('l-cashed').textContent = round.cashedOut;
  $('l-pnl').innerHTML = pnl(Math.round((round.profitUsd ?? 0) * 100) / 100);

  $('l-bets').innerHTML = round.bets.map((b) => {
    let profit;
    if (b.profitUsd != null) profit = pnl(b.profitUsd);
    else if (b.kind !== 'trenball' && round.status === 'running') profit = `<span class="muted">${usd(b.usd * (round.multiplier - 1))} potential</span>`;
    else profit = '<span class="muted">pending</span>';
    return `<tr class="click" data-player="${esc(b.playerId)}">
      <td>${esc(b.name)}</td>
      <td>${betType(b)}</td>
      <td class="r">${num(b.amount)} ${esc(b.currency)}</td>
      <td class="r">${usd(b.usd)}</td>
      <td class="r">${result(b)}</td>
      <td class="r">${profit}</td></tr>`;
  }).join('');
}

function betType(b) {
  if (b.kind === 'trenball') return `<span class="side ${esc((b.side || '').toLowerCase())}">${esc(b.side)}</span> <span class="muted">${x(b.payout)}</span>`;
  return 'Classic' + (b.slot ? ` <span class="muted">#${b.slot}</span>` : '');
}
function result(b) {
  if (b.kind === 'trenball') return b.won == null ? '–' : b.won ? '<span class="pos">win</span>' : '<span class="neg">lose</span>';
  if (b.cashedAt && b.won !== false) return `<span class="pos">${x(b.cashedAt)}</span>`;
  return b.won === false ? '<span class="neg">bust</span>' : '–';
}

// ---------- rounds ----------
let roundsCursor = null;
async function loadRounds(reset) {
  if (reset) { roundsCursor = null; $('r-body').innerHTML = ''; }
  const p = new URLSearchParams({ limit: 50 });
  if (roundsCursor) p.set('before', roundsCursor);
  if ($('r-min').value) p.set('minCrash', $('r-min').value);
  if ($('r-max').value) p.set('maxCrash', $('r-max').value);
  const rows = await api('/api/rounds?' + p);
  if (rows.length) roundsCursor = rows[rows.length - 1].endedAt;
  $('r-more').hidden = rows.length < 50;
  $('r-body').insertAdjacentHTML('beforeend', rows.map((r) => `<tr class="click" data-game="${esc(r.gameId)}">
    <td>#${esc(r.gameId)}${r.partial ? ' <span class="muted" title="Collector joined mid-round">*</span>' : ''}</td>
    <td>${time(r.endedAt)}</td>
    <td class="r"><span class="chip ${chipCls(r.crash)}">${x(r.crash)}</span></td>
    <td class="r">${r.playerCount}</td><td class="r">${r.winners}</td>
    <td class="r">${usd(r.wageredUsd)}</td><td class="r">${pnl(r.playersProfitUsd)}</td></tr>`).join(''));
}
$('r-apply').onclick = () => loadRounds(true);
$('r-more').onclick = () => loadRounds(false);

// ---------- players ----------
const PAGE = 50;
let playerPage = 0;
async function loadPlayers() {
  const p = new URLSearchParams({ sort: $('p-sort').value, order: $('p-order').value, limit: PAGE, skip: playerPage * PAGE });
  if ($('p-q').value.trim()) p.set('q', $('p-q').value.trim());
  const { total, items } = await api('/api/players?' + p);
  $('p-total').textContent = `${total.toLocaleString()} players`;
  $('p-page').textContent = `Page ${playerPage + 1} / ${Math.max(1, Math.ceil(total / PAGE))}`;
  $('p-prev').disabled = playerPage === 0;
  $('p-next').disabled = (playerPage + 1) * PAGE >= total;
  $('p-body').innerHTML = items.map((pl, i) => `<tr class="click" data-player="${esc(pl._id)}">
    <td class="muted">${playerPage * PAGE + i + 1}</td>
    <td>${esc(pl.name)}</td>
    <td class="r">${pl.rounds}</td>
    <td class="r">${pl.bets ?? pl.rounds}</td>
    <td class="r">${winPct(pl)}</td>
    <td class="r">${usd(pl.wageredUsd)}</td>
    <td class="r">${pnl(pl.profitUsd)}</td>
    <td class="r">${roi(pl.profitUsd, pl.wageredUsd)}</td>
    <td class="r">${pnl(pl.biggestWinUsd)}</td>
    <td class="r">${pnl(pl.biggestLossUsd)}</td>
    <td class="r">${x(pl.bestMultiplier || null)}</td>
    <td>${time(pl.lastSeen)}</td></tr>`).join('');
}
let searchTimer;
$('p-q').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { playerPage = 0; loadPlayers(); }, 300); };
$('p-sort').onchange = $('p-order').onchange = () => { playerPage = 0; loadPlayers(); };
$('p-prev').onclick = () => { playerPage--; loadPlayers(); };
$('p-next').onclick = () => { playerPage++; loadPlayers(); };

// ---------- stats ----------
async function loadStats() {
  const { totals: t, buckets, players } = await api('/api/stats');
  const card = (label, v) => `<div class="card"><label>${label}</label><div>${v}</div></div>`;
  $('s-cards').innerHTML = [
    card('Rounds recorded', (t.rounds || 0).toLocaleString()),
    card('Players seen', players.toLocaleString()),
    card('Bets', (t.bets || 0).toLocaleString()),
    card('Total wagered', usd(t.wageredUsd || 0)),
    card('Classic / Trenball wagered', `${usd(t.classicWageredUsd || 0)} / ${usd(t.trenballWageredUsd || 0)}`),
    card('Players P/L (all)', pnl(t.playersProfitUsd || 0)),
    card('House edge observed', t.wageredUsd ? ((-t.playersProfitUsd / t.wageredUsd) * 100).toFixed(2) + '%' : '–'),
    card('Average crash', x(t.avgCrash)),
    card('Highest crash', x(t.maxCrash)),
  ].join('');
  const labels = { 0: '1.00x', 1.01: '1.01–1.5x', 1.5: '1.5–2x', 2: '2–3x', 3: '3–5x', 5: '5–10x', 10: '10–100x', '100+': '100x+' };
  const total = buckets.reduce((s, b) => s + b.count, 0) || 1;
  const max = Math.max(1, ...buckets.map((b) => b.count));
  $('s-dist').innerHTML = buckets.map((b) => `<div class="bar"><span>${labels[b._id] ?? b._id}</span>
    <i style="width:${(b.count / max) * 100}%"></i><span class="muted">${b.count} (${((b.count / total) * 100).toFixed(1)}%)</span></div>`).join('');
}

// ---------- detail drawer ----------
function openDrawer(html) { $('d-body').innerHTML = html; $('drawer').hidden = false; }
$('d-close').onclick = () => { $('drawer').hidden = true; };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('drawer').hidden = true; });

async function showRound(gameId) {
  try {
    const { round: r, bets } = await api('/api/rounds/' + encodeURIComponent(gameId));
    openDrawer(`<h2>Round #${esc(r.gameId)} — <span class="chip ${chipCls(r.crash)}">${x(r.crash)}</span></h2>
      <p class="muted">${time(r.startedAt)} → ${time(r.endedAt)}${r.hash ? `<br>hash: <code>${esc(r.hash)}</code>` : ''}${r.partial ? '<br>Collector joined mid-round — some bets may be missing.' : ''}</p>
      <div class="cards">
        <div class="card"><label>Players</label><div>${r.playerCount}</div></div>
        <div class="card"><label>Winners</label><div>${r.winners}</div></div>
        <div class="card"><label>Wagered</label><div>${usd(r.wageredUsd)}</div></div>
        <div class="card"><label>Players P/L</label><div>${pnl(r.playersProfitUsd)}</div></div>
      </div>
      <table><thead><tr><th>Player</th><th>Type</th><th class="r">Bet</th><th class="r">USD</th><th class="r">Result</th><th class="r">Profit</th></tr></thead><tbody>
      ${bets.map((b) => `<tr class="click" data-player="${esc(b.playerId)}"><td>${esc(b.name)}</td><td>${betType(b)}</td><td class="r">${num(b.amount)} ${esc(b.currency)}</td>
        <td class="r">${usd(b.usd)}</td><td class="r">${result(b)}</td><td class="r">${pnl(b.profitUsd)}</td></tr>`).join('')}
      </tbody></table>`);
  } catch {
    openDrawer('<p class="muted">Round not saved yet.</p>');
  }
}

async function showPlayer(id) {
  try {
    const { player: p, bets } = await api('/api/players/' + encodeURIComponent(id));
    openDrawer(`<h2>${esc(p.name)}</h2><p class="muted">ID ${esc(p._id)} · first seen ${time(p.firstSeen)} · last seen ${time(p.lastSeen)}</p>
      <div class="cards">
        <div class="card"><label>Rounds / bets</label><div>${p.rounds} / ${p.bets ?? p.rounds}</div></div>
        <div class="card"><label>Classic / Trenball</label><div>${p.classicBets ?? '–'} / ${p.trenballBets ?? '–'}</div></div>
        <div class="card"><label>Wins / losses</label><div>${p.wins} / ${p.losses} <small>(${winPct(p)})</small></div></div>
        <div class="card"><label>Wagered</label><div>${usd(p.wageredUsd)}</div></div>
        <div class="card"><label>Profit</label><div>${pnl(p.profitUsd)}</div></div>
        <div class="card"><label>Biggest win</label><div>${pnl(p.biggestWinUsd)}</div></div>
        <div class="card"><label>Biggest loss</label><div>${pnl(p.biggestLossUsd)}</div></div>
      </div>
      <h3>Last ${bets.length} bets</h3>
      <table><thead><tr><th>Round</th><th>Time</th><th class="r">Crash</th><th class="r">Bet</th><th class="r">USD</th><th class="r">Cashed</th><th class="r">Profit</th></tr></thead><tbody>
      ${bets.map((b) => `<tr class="click" data-game="${esc(b.gameId)}"><td>#${esc(b.gameId)}</td><td>${time(b.at)}</td><td class="r">${x(b.crash)}</td>
        <td class="r">${num(b.amount)} ${esc(b.currency)}</td><td class="r">${usd(b.usd)}</td><td class="r">${b.won ? x(b.cashedAt) : '<span class="neg">bust</span>'}</td><td class="r">${pnl(b.profitUsd)}</td></tr>`).join('')}
      </tbody></table>`);
  } catch {
    openDrawer('<p class="muted">No saved history for this player yet (stats appear after their first round ends).</p>');
  }
}

// Any row/chip with data-game or data-player opens the matching detail.
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-game]');
  if (g) return showRound(g.dataset.game);
  const p = e.target.closest('[data-player]');
  if (p) return showPlayer(p.dataset.player);
});
