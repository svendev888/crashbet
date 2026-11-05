// Summarizes a capture file: which message types appear, how often, and one
// sample of each. Writes captures/summary-*.txt.
//   npm run analyze                       (latest capture)
//   npm run analyze -- captures/frames-X.jsonl
const fs = require('fs');
const path = require('path');
const { decode } = require('./parser');

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

const groups = new Map();
const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
for (const line of lines) {
  const f = JSON.parse(line);
  let key;
  let sample;
  if (f.b64) {
    const buf = Buffer.from(f.b64, 'base64');
    key = `${f.dir} BINARY ${new URL(f.url).host} first-bytes=${buf.subarray(0, 4).toString('hex')}`;
    sample = `len=${buf.length} hex=${buf.subarray(0, 120).toString('hex')}\ntext=${buf.subarray(0, 300).toString('latin1').replace(/[^\x20-\x7e]/g, '.')}`;
  } else {
    let msg = null;
    try {
      msg = decode({ ...f, dir: f.dir === 'out' ? 'in' : f.dir });
    } catch {
      /* not JSON */
    }
    key = `${f.dir} ${msg ? msg.event : 'raw:' + f.text.slice(0, 20)}`;
    sample = msg ? JSON.stringify(msg.data) : f.text;
  }
  const g = groups.get(key) || { count: 0, sample: '', url: f.url };
  g.count += 1;
  if (!g.sample) g.sample = sample.slice(0, 1500);
  groups.set(key, g);
}

let report = `Capture: ${file}\nFrames: ${lines.length}\n\n`;
for (const [key, g] of [...groups].sort((a, b) => b[1].count - a[1].count)) {
  report += `=== ${key}  (x${g.count})\nurl: ${g.url}\n${g.sample}\n\n`;
}
const outFile = file.replace(/frames-/, 'summary-').replace(/\.jsonl$/, '.txt');
fs.writeFileSync(outFile, report);
console.log(report.slice(0, 6000));
console.log(`\nFull summary written to ${outFile}`);
