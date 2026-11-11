// BC.Game Crash provably-fair calculation, following BC.Game's published
// verifier (github.com/bcgame-project/verify, crash.html):
//
//   hmac  = HMAC_SHA256(key = salt, message = bytes of the round hash)
//   r     = first 13 hex chars of hmac (52 bits)
//   X     = r / 2^52, rounded to 9 significant digits
//   crash = max(1, floor(99 / (1 - X)) / 100)
//
// Hash chain: each round's hash = SHA-256 of the next round's hash (as hex text),
// so a revealed hash proves the previous round's result was fixed in advance.
const crypto = require('crypto');

// Salt = hash of Bitcoin block #967,100 (announced 2026-09-15), used from round #9,614,372.
// Older rounds used a different salt and are not covered here.
const SALT = '000000000000000000010283162e089cc99f643ee5043141412e839945afe2f9';
const SALT_FROM_GAME = 9614372;
const SALT_SOURCE = 'Bitcoin block #967,100 hash (BC.Game reseeding, 15 Sep 2026)';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function crashFromHash(hash) {
  const hmac = crypto.createHmac('sha256', SALT).update(Buffer.from(hash, 'hex')).digest('hex');
  const hex = hmac.slice(0, 13);
  const r = parseInt(hex, 16);
  const x = parseFloat((r / 2 ** 52).toPrecision(9));
  const y = 99 / (1 - x);
  const crash = Math.max(1, Math.floor(y) / 100);
  return { hmac, hex, r, x, y, crash };
}

const isHash = (h) => typeof h === 'string' && /^[0-9a-f]{64}$/i.test(h);

// Full step-by-step explanation for one round.
// prevHash: hash of the round before (gameId - 1), if stored.
function explain(round, prevHash) {
  if (!isHash(round.hash)) return { available: false, reason: 'No hash recorded for this round.' };
  if (Number(round.gameId) < SALT_FROM_GAME) {
    return { available: false, reason: `Round is older than #${SALT_FROM_GAME}, which used a different salt.` };
  }
  const c = crashFromHash(round.hash.toLowerCase());
  const nextInChain = sha256(round.hash.toLowerCase());
  return {
    available: true,
    hash: round.hash,
    salt: SALT,
    saltSource: SALT_SOURCE,
    ...c,
    recorded: round.crash,
    matches: c.crash === round.crash,
    chain: {
      sha256OfHash: nextInChain,
      previousHash: prevHash || null,
      linked: prevHash ? nextInChain === prevHash.toLowerCase() : null,
    },
  };
}

// Quick yes/no for list views. null = cannot check.
function verified(round) {
  if (!isHash(round.hash) || Number(round.gameId) < SALT_FROM_GAME) return null;
  return crashFromHash(round.hash.toLowerCase()).crash === round.crash;
}

module.exports = { explain, verified, crashFromHash, SALT };
