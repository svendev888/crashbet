// Feeds a saved capture into the server, as if it were live.
//   npm run replay                        (latest capture)
//   npm run replay -- captures/frames-X.jsonl
const fs = require('fs');
const path = require('path');
const { parse } = require('./parser');
const { createPoster } = require('./post');

const dir = path.join(__dirname, '..', 'captures');
let file = process.argv[2];
if (!file) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('frames-')).sort() : [];
  if (!files.length) {
    console.error('No captures found. Run: npm run capture');
    process.exit(1);
  }
  file = path.join(dir, files[files.length - 1]);
}

const poster = createPoster(50);
let n = 0;
for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
  const evs = parse(JSON.parse(line));
  n += evs.length;
  poster.push(...evs);
}
console.log(`Sending ${n} events from ${file}`);
poster.flush().then(() => setTimeout(() => process.exit(0), 1000));
