// Analysis tab: charts over the last N saved rounds. Plain SVG, no libraries.
// Uses helpers from app.js ($, usd, x, time, api, showRound).

const SVGNS = 'http://www.w3.org/2000/svg';
const THRESHOLDS = [1.1, 1.2, 1.5, 2, 3, 5, 10, 20, 50, 100];
const expectedRate = (t) => Math.min(1, 0.99 / t); // P(crash >= t)
let analysisRows = [];

function svgEl(tag, attrs, parent) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

function newChart(container, height) {
  container.textContent = '';
  const width = Math.max(300, container.clientWidth);
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img' }, container);
  return { svg, width, height };
}

// ---------- tooltip ----------
const tip = $('tip');
function showTip(evt, title, rows) {
  tip.textContent = '';
  const t = document.createElement('div');
  t.className = 'tl';
  t.textContent = title;
  tip.appendChild(t);
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'tr';
    if (r.color) {
      const k = document.createElement('i');
      k.className = 'key';
      k.style.background = r.color;
      row.appendChild(k);
    }
    const v = document.createElement('span');
    v.className = 'tv';
    v.textContent = r.value;
    row.appendChild(v);
    if (r.label) {
      const l = document.createElement('span');
      l.className = 'tl';
      l.textContent = r.label;
      row.appendChild(l);
    }
    tip.appendChild(row);
  }
  tip.hidden = false;
  const pad = 14;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let left = evt.clientX + pad;
  if (left + w > window.innerWidth - 8) left = evt.clientX - w - pad;
  let top = evt.clientY - h - pad;
  if (top < 8) top = evt.clientY + pad;
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}
function hideTip() { tip.hidden = true; }

// ---------- shared pieces ----------
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const compactUsd = (v) => {
  const a = Math.abs(v);
  const s = a >= 1e6 ? (a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M' : a >= 1e4 ? (a / 1e3).toFixed(0) + 'K' : a.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return (v < 0 ? '-$' : '$') + s;
};
function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}
// Column path: square at the baseline, 4px rounded data-end (only when wide enough).
function columnPath(x0, w, yBase, yEnd) {
  const up = yEnd < yBase;
  const h = Math.abs(yBase - yEnd);
  const r = Math.min(4, w / 2, h);
  if (w < 6 || r < 1) return `M${x0},${yBase}V${yEnd}H${x0 + w}V${yBase}Z`;
  const s = up ? 1 : -1;
  return `M${x0},${yBase}V${yEnd + s * r}Q${x0},${yEnd} ${x0 + r},${yEnd}H${x0 + w - r}Q${x0 + w},${yEnd} ${x0 + w},${yEnd + s * r}V${yBase}Z`;
}
// Bands for N columns: <=24px thick, 2px surface gap when they are wide enough to show it.
function bands(n, x0, x1) {
  const slot = (x1 - x0) / Math.max(1, n);
  const gap = slot >= 6 ? 2 : 0;
  const w = Math.max(0.6, Math.min(24, slot - gap));
  return { slot, w, at: (i) => x0 + i * slot + (slot - w) / 2 };
}
function emptyChart(container, h, text) {
  const { svg, width } = newChart(container, h);
  svgEl('text', { x: width / 2, y: h / 2, 'text-anchor': 'middle', class: 'empty' }, svg).textContent = text;
}
// Hover that snaps to the nearest column index; draws a hairline.
function columnHover(svg, n, b, top, bottom, onHover, onClick) {
  const hair = svgEl('line', { class: 'hair', y1: top, y2: bottom, visibility: 'hidden' }, svg);
  const hit = svgEl('rect', { class: 'hit', x: b.at(0) - b.slot / 2, y: top, width: b.slot * n + b.slot, height: bottom - top }, svg);
  const idxAt = (evt) => {
    const p = svg.createSVGPoint();
    p.x = evt.clientX;
    p.y = evt.clientY;
    const loc = p.matrixTransform(svg.getScreenCTM().inverse());
    return Math.max(0, Math.min(n - 1, Math.floor((loc.x - b.at(0) + (b.slot - b.w) / 2) / b.slot)));
  };
  hit.addEventListener('pointermove', (evt) => {
    const i = idxAt(evt);
    const cx = b.at(i) + b.w / 2;
    hair.setAttribute('x1', cx);
    hair.setAttribute('x2', cx);
    hair.setAttribute('visibility', 'visible');
    onHover(evt, i);
  });
  hit.addEventListener('pointerleave', () => { hair.setAttribute('visibility', 'hidden'); hideTip(); });
  if (onClick) hit.addEventListener('click', (evt) => onClick(idxAt(evt)));
  return { hit, idxAt };
}

// ---------- 1. crash point per round (log scale) ----------
function drawHistory(container, rows) {
  const H = 260;
  if (!rows.length) return emptyChart(container, H, 'No rounds saved yet');
  const { svg, width } = newChart(container, H);
  const m = { l: 44, r: 12, t: 10, b: 22 };
  const maxC = Math.max(10, ...rows.map((r) => r.crash || 1));
  const lmax = Math.log10(maxC * 1.1);
  const y = (v) => m.t + (H - m.t - m.b) * (1 - Math.log10(Math.max(1, v)) / lmax);
  const yBase = y(1);
  for (const t of [1, 2, 5, 10, 100, 1000, 10000, 100000].filter((t) => t <= maxC * 1.1)) {
    if (t > 1) svgEl('line', { class: 'gridline', x1: m.l, x2: width - m.r, y1: y(t), y2: y(t) }, svg);
    svgEl('text', { class: 'tick', x: m.l - 6, y: y(t) + 4, 'text-anchor': 'end' }, svg).textContent = t + 'x';
  }
  const b = bands(rows.length, m.l, width - m.r);
  const color = css('--series-1');
  const g = svgEl('g', { fill: color }, svg);
  rows.forEach((r, i) => {
    const yEnd = Math.min(yBase - 1, y(r.crash)); // instant busts keep a 1px stub so they stay visible
    svgEl('path', { d: columnPath(b.at(i), b.w, yBase, yEnd) }, g);
  });
  for (const t of [2, 10]) {
    svgEl('line', { class: 'ref', x1: m.l, x2: width - m.r, y1: y(t), y2: y(t) }, svg);
  }
  svgEl('line', { class: 'baseline', x1: m.l, x2: width - m.r, y1: yBase, y2: yBase }, svg);
  axisDates(svg, rows, b, H - 6);
  columnHover(svg, rows.length, b, m.t, yBase, (evt, i) => {
    const r = rows[i];
    showTip(evt, `Round #${r.gameId} · ${time(r.endedAt)}`, [
      { value: x(r.crash), label: 'crash', color },
      { value: (r.playerCount ?? '–') + ' players', label: `${r.betCount ?? '–'} bets` },
    ]);
  }, (i) => showRound(rows[i].gameId));
}

function axisDates(svg, rows, b, yText) {
  if (rows.length < 2) return;
  const fmt = (d) => new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const first = svgEl('text', { class: 'tick', x: b.at(0), y: yText, 'text-anchor': 'start' }, svg);
  first.textContent = fmt(rows[0].endedAt);
  const last = svgEl('text', { class: 'tick', x: b.at(rows.length - 1) + b.w, y: yText, 'text-anchor': 'end' }, svg);
  last.textContent = fmt(rows[rows.length - 1].endedAt);
}

// ---------- 2. observed vs expected survival ----------
function drawSurvival(container, rows) {
  const H = 240;
  if (!rows.length) return emptyChart(container, H, 'No rounds saved yet');
  const { svg, width } = newChart(container, H);
  const m = { l: 44, r: 24, t: 12, b: 24 };
  const n = rows.length;
  const pts = THRESHOLDS.map((t) => ({ t, obs: rows.filter((r) => r.crash >= t).length / n, exp: expectedRate(t) }));
  const xs = (i) => m.l + ((width - m.l - m.r) * i) / (pts.length - 1);
  const y = (v) => m.t + (H - m.t - m.b) * (1 - v);
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    svgEl('line', { class: v === 0 ? 'baseline' : 'gridline', x1: m.l, x2: width - m.r, y1: y(v), y2: y(v) }, svg);
    svgEl('text', { class: 'tick', x: m.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, svg).textContent = v * 100 + '%';
  }
  // Narrow screens: label every other threshold so the labels never touch (tooltip has all).
  const every = (width - m.l - m.r) / (pts.length - 1) < 44 ? 2 : 1;
  pts.forEach((p, i) => {
    if (i % every) return;
    svgEl('text', { class: 'tick', x: xs(i), y: H - 6, 'text-anchor': 'middle' }, svg).textContent = '≥' + p.t + 'x';
  });
  const surface = css('--panel');
  const series = [
    { key: 'exp', name: 'Expected', color: css('--series-2') },
    { key: 'obs', name: 'Observed', color: css('--series-1') },
  ];
  for (const s of series) {
    svgEl('path', {
      d: pts.map((p, i) => `${i ? 'L' : 'M'}${xs(i)},${y(p[s.key])}`).join(''),
      fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }, svg);
    pts.forEach((p, i) => svgEl('circle', { cx: xs(i), cy: y(p[s.key]), r: 4, fill: s.color, stroke: surface, 'stroke-width': 2 }, svg));
  }
  // Direct labels at the first point (the series separate most there), legend carries the rest.
  const p0 = pts[0];
  const [hi, lo] = p0.obs >= p0.exp ? ['obs', 'exp'] : ['exp', 'obs'];
  const label = (k) => (k === 'obs' ? 'Observed ' : 'Expected ') + (p0[k] * 100).toFixed(1) + '%';
  if (Math.abs(y(p0.obs) - y(p0.exp)) > 14) {
    svgEl('text', { class: 'endlabel', x: xs(0) + 8, y: y(p0[hi]) - 8 }, svg).textContent = label(hi);
    svgEl('text', { class: 'endlabel', x: xs(0) + 8, y: y(p0[lo]) + 16 }, svg).textContent = label(lo);
  }
  // Crosshair snapping to the nearest threshold.
  const hair = svgEl('line', { class: 'hair', y1: m.t, y2: y(0), visibility: 'hidden' }, svg);
  const hit = svgEl('rect', { class: 'hit', x: m.l - 10, y: m.t, width: width - m.l - m.r + 20, height: y(0) - m.t }, svg);
  hit.style.cursor = 'crosshair';
  hit.addEventListener('pointermove', (evt) => {
    const p = svg.createSVGPoint();
    p.x = evt.clientX;
    p.y = evt.clientY;
    const lx = p.matrixTransform(svg.getScreenCTM().inverse()).x;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((lx - m.l) / (width - m.l - m.r)) * (pts.length - 1))));
    hair.setAttribute('x1', xs(i));
    hair.setAttribute('x2', xs(i));
    hair.setAttribute('visibility', 'visible');
    const q = pts[i];
    showTip(evt, `Reached ≥ ${q.t}x`, [
      { value: (q.obs * 100).toFixed(1) + '%', label: `observed (${Math.round(q.obs * n)} of ${n})`, color: css('--series-1') },
      { value: (q.exp * 100).toFixed(1) + '%', label: 'expected', color: css('--series-2') },
    ]);
  });
  hit.addEventListener('pointerleave', () => { hair.setAttribute('visibility', 'hidden'); hideTip(); });
}

// ---------- 3 & 4. money per round ----------
function drawMoney(container, rows, field, { diverging }) {
  const H = 200;
  if (!rows.length) return emptyChart(container, H, 'No rounds saved yet');
  const { svg, width } = newChart(container, H);
  const m = { l: 56, r: 12, t: 10, b: 22 };
  const vals = rows.map((r) => r[field] || 0);
  const lo = diverging ? Math.min(0, ...vals) : 0;
  const hi = Math.max(diverging ? 0 : 1, ...vals);
  const ticks = niceTicks(lo, hi);
  const tmin = Math.min(lo, ticks[0]);
  const tmax = Math.max(hi, ticks[ticks.length - 1]);
  const y = (v) => m.t + (H - m.t - m.b) * (1 - (v - tmin) / (tmax - tmin || 1));
  for (const t of ticks) {
    svgEl('line', { class: t === 0 ? 'baseline' : 'gridline', x1: m.l, x2: width - m.r, y1: y(t), y2: y(t) }, svg);
    svgEl('text', { class: 'tick', x: m.l - 6, y: y(t) + 4, 'text-anchor': 'end' }, svg).textContent = compactUsd(t);
  }
  const b = bands(rows.length, m.l, width - m.r);
  const up = css('--series-1');
  const down = css('--series-3');
  const y0 = y(0);
  vals.forEach((v, i) => {
    if (!v) return;
    svgEl('path', { d: columnPath(b.at(i), b.w, y0, y(v)), fill: v < 0 ? down : up }, svg);
  });
  svgEl('line', { class: 'baseline', x1: m.l, x2: width - m.r, y1: y0, y2: y0 }, svg);
  axisDates(svg, rows, b, H - 6);
  columnHover(svg, rows.length, b, m.t, H - m.b, (evt, i) => {
    const r = rows[i];
    const v = vals[i];
    const out = diverging
      ? [{ value: (v > 0 ? '+' : '') + usd(v), label: v >= 0 ? 'players won' : 'house won', color: v < 0 ? down : up },
         { value: usd(r.wageredUsd), label: 'wagered' }]
      : [{ value: usd(v), label: 'wagered', color: up }, { value: x(r.crash), label: 'crash' }];
    if (r.partial) out.push({ value: 'partial', label: 'collector joined mid-round' });
    showTip(evt, `Round #${r.gameId} · ${time(r.endedAt)}`, out);
  }, (i) => showRound(rows[i].gameId));
}

// ---------- 2x walk: +1 when a round reaches the target, -1 when it doesn't ----------
const WALK_TARGET = 2;
function drawWalk(container, rows) {
  const H = 240;
  if (!rows.length) return emptyChart(container, H, 'No rounds saved yet');
  const { svg, width } = newChart(container, H);
  const m = { l: 44, r: 44, t: 12, b: 22 };
  const p = expectedRate(WALK_TARGET);
  const drift = 2 * p - 1; // expected change per round (-0.01 at 2x)
  const sdStep = 2 * Math.sqrt(p * (1 - p));
  const walk = [];
  let v = 0;
  for (const r of rows) { v += r.crash >= WALK_TARGET ? 1 : -1; walk.push(v); }
  const n = rows.length;
  const exp = (k) => k * drift;
  const band = (k) => 1.96 * sdStep * Math.sqrt(k);
  const lo = Math.min(0, ...walk, exp(n) - band(n));
  const hi = Math.max(0, ...walk, exp(n) + band(n));
  const ticks = niceTicks(lo, hi).filter((t) => Number.isInteger(t));
  const tmin = Math.min(lo, ticks[0] ?? lo);
  const tmax = Math.max(hi, ticks[ticks.length - 1] ?? hi);
  const y = (val) => m.t + (H - m.t - m.b) * (1 - (val - tmin) / (tmax - tmin || 1));
  for (const t of ticks) {
    svgEl('line', { class: t === 0 ? 'baseline' : 'gridline', x1: m.l, x2: width - m.r, y1: y(t), y2: y(t) }, svg);
    svgEl('text', { class: 'tick', x: m.l - 6, y: y(t) + 4, 'text-anchor': 'end' }, svg).textContent = (t > 0 ? '+' : '') + t;
  }
  const b = bands(n, m.l, width - m.r);
  const cx = (i) => b.at(i) + b.w / 2;
  const x0 = b.at(0);
  // 95% range of a fair game, around the expected drift.
  let area = `M${x0},${y(0)}`;
  for (let i = 0; i < n; i++) area += `L${cx(i)},${y(exp(i + 1) + band(i + 1))}`;
  for (let i = n - 1; i >= 0; i--) area += `L${cx(i)},${y(exp(i + 1) - band(i + 1))}`;
  svgEl('path', { d: area + 'Z', class: 'walk-band' }, svg);
  svgEl('line', { class: 'walk-exp', x1: x0, y1: y(0), x2: cx(n - 1), y2: y(exp(n)) }, svg);
  svgEl('line', { class: 'baseline', x1: m.l, x2: width - m.r, y1: y(0), y2: y(0) }, svg);
  // The walk itself: a step line, flat within a round, jumping at the next one.
  let d = `M${x0},${y(0)}`;
  walk.forEach((val, i) => { d += `V${y(val)}H${i + 1 < n ? cx(i + 1) : cx(i)}`; });
  const color = css('--series-1');
  svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
  const last = walk[n - 1];
  svgEl('text', { class: 'endlabel', x: cx(n - 1) + 6, y: y(last) + 4 }, svg).textContent = (last > 0 ? '+' : '') + last;
  axisDates(svg, rows, b, H - 6);
  const dot = svgEl('circle', { r: 4, fill: color, stroke: css('--panel'), 'stroke-width': 2, visibility: 'hidden', 'pointer-events': 'none' }, svg);
  const selRect = svgEl('rect', { class: 'walk-sel', y: m.t, height: H - m.t - m.b, visibility: 'hidden', 'pointer-events': 'none' }, svg);
  const showSel = (i, j) => {
    const [a, z] = i <= j ? [i, j] : [j, i];
    selRect.setAttribute('x', b.at(a) - (b.slot - b.w) / 2);
    selRect.setAttribute('width', b.slot * (z - a + 1));
    selRect.setAttribute('visibility', 'visible');
  };
  let dragFrom = null;
  let dragged = false;
  const { hit, idxAt } = columnHover(svg, n, b, m.t, H - m.b, (evt, i) => {
    if (dragFrom != null) {
      if (i !== dragFrom) dragged = true;
      if (dragged) { showSel(dragFrom, i); hideTip(); return; }
    }
    const r = rows[i];
    const hit = r.crash >= WALK_TARGET;
    dot.setAttribute('cx', cx(i));
    dot.setAttribute('cy', y(walk[i]));
    dot.setAttribute('visibility', 'visible');
    showTip(evt, `Round #${r.gameId} · ${time(r.endedAt)}`, [
      { value: `${x(r.crash)}  ${hit ? '+1' : '−1'}`, label: hit ? `reached ${WALK_TARGET}x` : `below ${WALK_TARGET}x` },
      { value: (walk[i] > 0 ? '+' : '') + walk[i], label: 'running total', color },
      { value: exp(i + 1).toFixed(1), label: `fair expectation (95%: ${(exp(i + 1) - band(i + 1)).toFixed(0)} to +${(exp(i + 1) + band(i + 1)).toFixed(0)})` },
    ]);
  }, (i) => { if (dragged) { dragged = false; return; } showRound(rows[i].gameId); });
  svg.addEventListener('pointerleave', () => dot.setAttribute('visibility', 'hidden'));

  // Drag across the chart to select a period; its counts show under the chart.
  hit.style.touchAction = 'pan-y';
  hit.addEventListener('pointerdown', (evt) => {
    if (evt.button !== 0) return;
    dragFrom = idxAt(evt);
    dragged = false;
    hit.setPointerCapture(evt.pointerId);
  });
  const endDrag = (evt) => {
    if (dragFrom == null) return;
    const to = idxAt(evt);
    if (dragged) {
      const [a, z] = dragFrom <= to ? [dragFrom, to] : [to, dragFrom];
      walkSel = { from: rows[a].gameId, to: rows[z].gameId };
      renderWalkSel(rows, walk);
    }
    dragFrom = null;
  };
  hit.addEventListener('pointerup', endDrag);
  hit.addEventListener('pointercancel', () => { dragFrom = null; dragged = false; });

  // Keep a saved selection after redraws (resize, new round).
  const sel = walkSelIdx(rows);
  if (sel) showSel(sel[0], sel[1]);
  renderWalkSel(rows, walk);

  const ups = walk.length ? rows.filter((r) => r.crash >= WALK_TARGET).length : 0;
  $('a-walk-sum').textContent = `${ups.toLocaleString()} up, ${(n - ups).toLocaleString()} down → ${(last > 0 ? '+' : '') + last}`;
}

// Selected period on the 2x chart, kept by game ID so it survives live refreshes.
let walkSel = null;
function walkSelIdx(rows) {
  if (!walkSel) return null;
  const a = rows.findIndex((r) => r.gameId === walkSel.from);
  const z = rows.findIndex((r) => r.gameId === walkSel.to);
  return a < 0 || z < 0 ? null : [a, z];
}
function renderWalkSel(rows, walk) {
  const box = $('a-walk-sel');
  const idx = walkSelIdx(rows);
  if (!idx) {
    if (walkSel && rows.length) walkSel = null; // selected rounds dropped out of the loaded range
    box.innerHTML = '<span class="muted">Drag across the chart to select a period.</span>';
    return;
  }
  const [a, z] = idx;
  const part = rows.slice(a, z + 1);
  const ups = part.filter((r) => r.crash >= WALK_TARGET).length;
  const downs = part.length - ups;
  const net = walk[z] - (a > 0 ? walk[a - 1] : 0);
  let run = 0;
  let longest = 0;
  for (const r of part) { if (r.crash < WALK_TARGET) longest = Math.max(longest, ++run); else run = 0; }
  const sign = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toLocaleString();
  box.innerHTML = `<b>Selected ${part.length.toLocaleString()} rounds</b>
    <span class="muted">#${esc(part[0].gameId)} – #${esc(part[part.length - 1].gameId)} · ${time(part[0].endedAt)} → ${time(part[part.length - 1].endedAt)}</span>
    <span><span class="pos">${ups.toLocaleString()} up</span> · <span class="neg">${downs.toLocaleString()} down</span> → <b>${sign(net)}</b></span>
    <span>Reached 2x ${((ups / part.length) * 100).toFixed(1)}%</span>
    <span>Longest run under 2x: <b>${longest.toLocaleString()}</b></span>
    <button type="button" id="a-walk-clear">Clear</button>`;
  $('a-walk-clear').onclick = clearWalkSel;
}
function clearWalkSel() {
  if (!walkSel) return;
  walkSel = null;
  drawWalk($('a-walk'), analysisRows);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && analysisActive()) clearWalkSel(); });

// ---------- tiles & threshold table ----------
function drawTiles(rows) {
  const n = rows.length;
  const sorted = rows.map((r) => r.crash).sort((a, b) => a - b);
  const median = n ? (n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : null;
  const rate = (t) => (n ? rows.filter((r) => r.crash >= t).length / n : 0);
  const since = (t) => { for (let i = n - 1; i >= 0; i--) if (rows[i].crash >= t) return n - 1 - i; return n; };
  const pl = rows.reduce((s, r) => s + (r.playersProfitUsd || 0), 0);
  const wag = rows.reduce((s, r) => s + (r.wageredUsd || 0), 0);
  const tile = (label, value, note) => `<div class="card"><label>${label}</label><div>${value}</div>${note ? `<small>${note}</small>` : ''}</div>`;
  $('a-tiles').innerHTML = [
    tile('Rounds analyzed', n.toLocaleString()),
    tile('Median crash', x(median), 'expected 1.98x'),
    tile('Reached 2x', (rate(2) * 100).toFixed(1) + '%', 'expected 49.5%'),
    tile('Reached 10x', (rate(10) * 100).toFixed(1) + '%', 'expected 9.9%'),
    tile('Rounds since last 10x', since(10).toLocaleString(), 'average gap ≈ 10'),
    tile('Players P/L', pnl(Math.round(pl * 100) / 100), wag ? `on ${usd(wag)} wagered` : ''),
  ].join('');
}

function drawThresholds(rows) {
  const n = rows.length;
  $('a-thresholds').innerHTML = THRESHOLDS.map((t) => {
    let hits = 0;
    let run = 0;
    let longest = 0;
    for (const r of rows) {
      if (r.crash >= t) { hits++; run = 0; } else { run++; longest = Math.max(longest, run); }
    }
    const exp = expectedRate(t);
    const obs = n ? hits / n : 0;
    return `<tr><td>≥ ${t}x</td><td class="r">${hits.toLocaleString()}</td>
      <td class="r">${(obs * 100).toFixed(1)}%</td><td class="r muted">${(exp * 100).toFixed(1)}%</td>
      <td class="r">${run.toLocaleString()}</td><td class="r">${longest.toLocaleString()}</td>
      <td class="r muted">${(1 / exp).toFixed(1)}</td></tr>`;
  }).join('');
}

// ---------- load & render ----------
function renderAnalysis() {
  const rows = analysisRows;
  drawTiles(rows);
  drawHistory($('a-history'), rows);
  drawWalk($('a-walk'), rows);
  drawSurvival($('a-survival'), rows);
  drawMoney($('a-pnl'), rows, 'playersProfitUsd', { diverging: true });
  drawMoney($('a-wager'), rows, 'wageredUsd', { diverging: false });
  drawThresholds(rows);
  $('a-info').textContent = rows.length
    ? `${time(rows[0].endedAt)} → ${time(rows[rows.length - 1].endedAt)}`
    : '';
}

async function loadAnalysis() {
  analysisRows = await api('/api/analysis?limit=' + $('a-limit').value);
  renderAnalysis();
}

$('a-limit').onchange = loadAnalysis;

const analysisActive = () => $('tab-analysis').classList.contains('active');
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (analysisActive()) renderAnalysis(); }, 150);
});

// Refresh when a new round is saved while the tab is open.
let lastSeenRound = null;
socket.on('live', ({ recent }) => {
  const latest = recent && recent[0] && recent[0].gameId;
  if (latest && latest !== lastSeenRound) {
    const first = lastSeenRound == null;
    lastSeenRound = latest;
    if (!first && analysisActive()) loadAnalysis();
  }
});
