// Batches normalized events and sends them to the server's /ingest endpoint.
require('dotenv').config();

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const INGEST_KEY = process.env.INGEST_KEY || 'change-me';

function createPoster(intervalMs = 150) {
  let queue = [];
  let sending = false;

  async function flush() {
    if (sending || queue.length === 0) return;
    sending = true;
    const events = queue;
    queue = [];
    try {
      const res = await fetch(SERVER_URL + '/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ingest-key': INGEST_KEY },
        body: JSON.stringify({ events }),
      });
      if (!res.ok) console.error('ingest failed:', res.status, await res.text());
    } catch (e) {
      console.error('ingest error (is the server running?):', e.message);
      queue = events.concat(queue); // retry next tick
    } finally {
      sending = false;
    }
  }

  setInterval(flush, intervalMs);
  return { push: (...evs) => queue.push(...evs), flush };
}

module.exports = { createPoster };
