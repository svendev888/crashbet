// Decodes BC.Game crash traffic (socketv4.bc.game, namespace /g/cm) into the
// normalized events understood by src/live.js.
//
// Wire format (reverse-engineered from a capture on 2026-11-05):
//   binary frame = 0x04 | type(+0x80 if ack id) | [ack id u32] | nsLen ns | evLen ev | protobuf body
//   type 2 = event, 3 = ack reply (e.g. the answer to "join" = current round snapshot)
//
// Events in /g/cm (protobuf field numbers):
//   pr        prepare (betting opens)  1=gameId 3=betting start ms 4=launch ms
//   bg        begin (multiplier runs)  1=gameId 4=start ms
//   pg        progress tick            1=elapsed ms 2=gameId      multiplier = e^(0.00006 t)
//   ed        crashed                  1=gameId 6=crash x100
//   st        settled                  1=gameId 6=crash x100 7=hash
//   tb_batch  classic bets   1[]: 1=gameId 2=currency 3=amount 4{1=userId 2=slot} 5=name 6=betId
//   xb_batch  trenball bets  1[]: 1=gameId 2=currency 3=amount 4=userId 5=name 6=betId
//                                 7=target x100 (+ = crash >= x, - = crash < x)
//   e_batch   cash-outs      1[]: 1=userId 2=betId 3=rate x100 5=slot
//   join ack  snapshot       3{1=gameId 2=status 9=hash 15[]=trenball bets 21[]=classic bets(7=cashed rate)}

// ---------- minimal protobuf reader ----------
function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  for (;;) {
    if (pos.i >= buf.length) throw new Error('truncated varint');
    const b = buf[pos.i++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return result;
    shift += 7n;
  }
}

// Returns { [field]: [values...] } where values are BigInt (varint) or Buffer (bytes).
function pb(buf) {
  const out = {};
  const pos = { i: 0 };
  while (pos.i < buf.length) {
    const key = Number(readVarint(buf, pos));
    const field = key >> 3;
    const wire = key & 7;
    let val;
    if (wire === 0) val = readVarint(buf, pos);
    else if (wire === 2) {
      const len = Number(readVarint(buf, pos));
      val = buf.subarray(pos.i, pos.i + len);
      pos.i += len;
    } else if (wire === 1) { val = buf.subarray(pos.i, pos.i + 8); pos.i += 8; }
    else if (wire === 5) { val = buf.subarray(pos.i, pos.i + 4); pos.i += 4; }
    else throw new Error('unsupported wire type ' + wire);
    (out[field] || (out[field] = [])).push(val);
  }
  return out;
}
const first = (m, f) => (m[f] ? m[f][0] : undefined);
const num = (m, f) => (m[f] ? Number(BigInt.asIntN(64, m[f][0])) : undefined);
const idStr = (m, f) => (m[f] ? BigInt.asUintN(64, m[f][0]).toString() : undefined);
const str = (m, f) => (m[f] ? m[f][0].toString('utf8') : undefined);
const list = (m, f) => (m[f] || []).map(pb);

// ---------- frame header ----------
function header(buf) {
  if (buf.length < 4 || buf[0] !== 0x04) return null;
  let i = 1;
  const t = buf[i++];
  if (t & 0x80) i += 4;
  const nsLen = buf[i++];
  const ns = buf.subarray(i, i + nsLen).toString();
  i += nsLen;
  const evLen = buf[i++];
  const ev = buf.subarray(i, i + evLen).toString();
  i += evLen;
  return { type: t & 0x7f, ns, ev, body: buf.subarray(i) };
}

// ---------- USD prices (from the page's /conf/usdPrice response) ----------
const prices = {};
const missingPrice = new Set();
function toUsd(currency, amount) {
  const p = prices[currency];
  if (p == null) {
    if (!missingPrice.has(currency)) {
      missingPrice.add(currency);
      console.warn(`no USD price for ${currency} yet; counting as $0`);
    }
    return 0;
  }
  return Math.round(amount * p * 1e6) / 1e6;
}
function setPrices(obj) {
  for (const [k, v] of Object.entries(obj)) {
    const n = Number(v);
    if (Number.isFinite(n)) prices[k] = n;
  }
  missingPrice.clear();
}

// ---------- Trenball ----------
// Payout follows the 1% edge: >= x pays x, < x pays 0.99 / (1 - 0.99 / x).
// Gives Green 2x, Moon 10x, Red 1.96x, <1.01x 50x.
const SIDES = { 200: 'Green', 1000: 'Moon', '-200': 'Red' };
function trenball(target) {
  const x = Math.abs(target) / 100;
  const above = target > 0;
  const payout = above ? x : Math.round((0.99 / (1 - 0.99 / x)) * 100) / 100;
  return {
    side: SIDES[target] || (above ? `≥${x}x` : `<${x}x`),
    condition: { op: above ? '>=' : '<', x },
    payout,
  };
}

// ---------- message -> events ----------
function classicBet(b, gameId) {
  const owner = pb(first(b, 4));
  const currency = str(b, 2);
  const amount = Number(str(b, 3));
  const ev = {
    type: 'bet',
    kind: 'classic',
    gameId: gameId ?? num(b, 1),
    betId: idStr(b, 6),
    playerId: idStr(owner, 1),
    slot: num(owner, 2),
    name: str(b, 5),
    currency,
    amount,
    usd: toUsd(currency, amount),
  };
  const out = [ev];
  const cashed = num(b, 7); // only present in the join snapshot
  if (cashed > 0) out.push({ type: 'cashout', gameId: ev.gameId, betId: ev.betId, playerId: ev.playerId, multiplier: cashed / 100 });
  return out;
}

function trenballBet(b, gameId) {
  const currency = str(b, 2);
  const amount = Number(str(b, 3));
  return {
    type: 'bet',
    kind: 'trenball',
    gameId: gameId ?? num(b, 1),
    betId: idStr(b, 6),
    playerId: idStr(b, 4),
    name: str(b, 5),
    currency,
    amount,
    usd: toUsd(currency, amount),
    ...trenball(num(b, 7)),
  };
}

let currentGame = null;

const HANDLERS = {
  pr: (m) => {
    currentGame = num(m, 1);
    return { type: 'round_start', gameId: currentGame, at: num(m, 3) };
  },
  bg: (m) => ({ type: 'round_running', gameId: num(m, 1) }),
  pg: (m) => ({
    type: 'tick',
    gameId: num(m, 2),
    multiplier: Math.floor(Math.exp(0.00006 * num(m, 1)) * 100) / 100,
  }),
  ed: (m) => ({ type: 'crashed', gameId: num(m, 1), crash: num(m, 6) / 100 }),
  st: (m) => ({ type: 'round_end', gameId: num(m, 1), crash: num(m, 6) / 100, hash: str(m, 7) }),
  tb_batch: (m) => list(m, 1).flatMap((b) => classicBet(b)),
  xb_batch: (m) => list(m, 1).map((b) => trenballBet(b)),
  e_batch: (m) => list(m, 1).map((e) => ({
    type: 'cashout',
    gameId: currentGame,
    betId: idStr(e, 2),
    playerId: idStr(e, 1),
    multiplier: num(e, 3) / 100,
  })),
};

// Snapshot sent in reply to "join": lets us pick up a round already in progress.
function snapshot(m) {
  const s = first(m, 3) && pb(first(m, 3));
  if (!s || !s[1]) return [];
  currentGame = num(s, 1);
  const out = [{ type: 'round_join', gameId: currentGame }];
  for (const b of list(s, 21)) out.push(...classicBet(b, currentGame));
  for (const b of list(s, 15)) out.push(trenballBet(b, currentGame));
  return out;
}

function parse(frame) {
  if (frame.dir === 'http') {
    if (/\/conf\/usdPrice/.test(frame.url)) {
      const j = JSON.parse(frame.text);
      setPrices(j && typeof j.data === 'object' && j.data ? j.data : j); // response is { code, msg, data: {CUR: price} }
    }
    return [];
  }
  if (frame.dir !== 'in' || !frame.b64 || !/bc\.game/.test(frame.url)) return [];
  const h = header(Buffer.from(frame.b64, 'base64'));
  if (!h || h.ns !== '/g/cm') return [];
  if (h.type === 3) return snapshot(pb(h.body));
  const fn = HANDLERS[h.ev];
  if (h.type !== 2 || !fn) return [];
  const out = fn(pb(h.body));
  return out ? [].concat(out) : [];
}

module.exports = { parse, setPrices, header, pb, trenball };
