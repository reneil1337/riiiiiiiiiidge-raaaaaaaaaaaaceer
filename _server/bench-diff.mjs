// bench-diff.mjs - compare two bench artifacts in one table.
//
//   node bench-diff.mjs _runtime/bench-native-before.json _runtime/bench-native-after.json
//   node bench-diff.mjs ...json ...json --json          # also write a diff artifact
//   node bench-diff.mjs ...json ...json --compat-strict # fail on env mismatch
//
// Read-only: it never launches a browser. Schema is detected from the file, so
// native and netplay artifacts use the same command.
import fs from 'node:fs';
import path from 'node:path';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const wantJson = process.argv.includes('--json');
const compatStrict = process.argv.includes('--compat-strict');

if (files.length !== 2) {
  console.error('usage: node bench-diff.mjs <before.json> <after.json> [--json] [--compat-strict]');
  process.exit(2);
}

const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const before = read(files[0]);
const after = read(files[1]);
const get = (o, dotted) => dotted.split('.').reduce((v, k) => (v == null ? null : v[k]), o);
const round = (n, d = 2) => (n == null || !Number.isFinite(n) ? null : +n.toFixed(d));

const NATIVE = [
  { metric: 'frame.emuFps', label: 'emulator fps', unit: 'fps', better: 'up', noise: 0.005 },
  { metric: 'frame.variance.cvPct', label: 'steady CV', unit: '%', better: 'down', noise: 0.05 },
  { metric: 'frame.variance.p10BinFps', label: 'p10 1s bin', unit: 'fps', better: 'up', noise: 0.005 },
  { metric: 'frame.variance.minBinFps', label: 'min 1s bin', unit: 'fps', better: 'up', noise: 0.005 },
  { metric: 'frame.raf.p95', label: 'rAF p95', unit: 'ms', better: 'down', noise: 0.10 },
  { metric: 'frame.raf.over33Pct', label: 'frames >33.4ms', unit: '%', better: 'down', noise: 0.25 },
  { metric: 'frame.frames.dropped', label: 'emulated dropped', unit: 'frames', better: 'down', noise: 0.10 },
  { metric: 'input.synthetic.p50', label: 'input p50', unit: 'ms', better: 'down', noise: 0.05 },
  { metric: 'input.synthetic.p95', label: 'input p95', unit: 'ms', better: 'down', noise: 0.05 },
  { metric: 'input.cdp.p95', label: 'CDP input p95', unit: 'ms', better: 'down', noise: 0.25 },
  { metric: 'mainThread.busyPct', label: 'main-thread busy', unit: '%', better: 'down', noise: 0.05 },
  { metric: 'boot.wallMs', label: 'boot wall', unit: 'ms', better: 'down', noise: 0.25 },
  { metric: 'heap.usedMB', label: 'JS heap', unit: 'MB', better: 'down', noise: 0.05 },
  { metric: 'audio.afterRun.outputLatency', label: 'audio output latency', unit: 's', better: 'down', noise: 0.10 },
];

const NETPLAY = [
  { metric: 'host.emuFps', label: 'host core fps', unit: 'fps', better: 'up', noise: 0.005 },
  { metric: 'host.encodeFps', label: 'host encode fps', unit: 'fps', better: 'up', noise: 0.01 },
  { metric: 'host.sendKbps', label: 'host bitrate', unit: 'kbps', better: 'up', noise: 0.10 },
  { metric: 'host.avgEncodeMs', label: 'avg encode', unit: 'ms', better: 'down', noise: 0.10 },
  { metric: 'guest.displayFps', label: 'guest presented fps', unit: 'fps', better: 'up', noise: 0.01 },
  { metric: 'guest.decodedFps', label: 'guest decoded fps', unit: 'fps', better: 'up', noise: 0.01 },
  { metric: 'guest.droppedPct', label: 'guest presentation loss', unit: '%', better: 'down', noise: 0.20 },
  { metric: 'net.rttMs', label: 'RTT', unit: 'ms', better: 'down', noise: 0.10 },
  { metric: 'net.jitterBufferDelayMs', label: 'jitter buffer', unit: 'ms', better: 'down', noise: 0.15 },
  { metric: 'net.inbound.packetLossPct', label: 'packet loss', unit: '%', better: 'down', noise: 0.25 },
  { metric: 'net.inbound.jitterMs', label: 'jitter', unit: 'ms', better: 'down', noise: 0.20 },
  { metric: 'net.inbound.freezeCount', label: 'freezes', unit: '', better: 'down', noise: 0.10 },
];

const isNet = String(after.schema || before.schema || '').includes('netplay');
const metrics = isNet ? NETPLAY : NATIVE;

const compat = [];
const cmp = (key, label) => {
  const a = get(before, key);
  const b = get(after, key);
  if (JSON.stringify(a) !== JSON.stringify(b)) compat.push({ key, label, before: a, after: b });
};
cmp('schema', 'schema');
cmp('tier', 'threshold tier');
cmp('target.viewport', 'viewport');
cmp('target.headless', 'headless');
cmp('target.rafCap', 'rAF cap');
cmp('target.seconds', 'sample window');
cmp('env.browser', 'browser build');
cmp('env.gpu.renderer', 'GPU renderer');
cmp('env.cpu', 'CPU');

console.log(`BENCH DIFF  ${isNet ? 'netplay' : 'native'}  ${before.label} -> ${after.label}`);
console.log(`  before ${files[0]}  ${before.generatedAt}`);
console.log(`  after  ${files[1]}  ${after.generatedAt}`);
if (compat.length) {
  console.log('  COMPAT WARNINGS (a diff across these is not a like-for-like comparison):');
  for (const c of compat) console.log(`    ${c.label}: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`);
} else {
  console.log('  COMPAT ok (schema, tier, viewport, headless, sample window, browser, GPU, CPU)');
}

const rows = [];
for (const m of metrics) {
  const a = get(before, m.metric);
  const b = get(after, m.metric);
  if (a == null && b == null) continue;
  const abs = a != null && b != null ? b - a : null;
  const pct = a != null && b != null && a !== 0 ? ((b - a) / Math.abs(a)) * 100 : null;
  let verdict = 'n/a';
  if (abs != null) {
    const within = m.noise != null ? Math.abs(abs) <= Math.abs(a || 0) * m.noise : abs === 0;
    if (within) verdict = 'same';
    else verdict = (m.better === 'up' ? abs > 0 : abs < 0) ? 'better' : 'worse';
  }
  rows.push({ ...m, before: round(a, 2), after: round(b, 2), abs: round(abs, 2), pct: round(pct, 1), verdict });
}

const w = (s, n) => String(s ?? 'n/a').padEnd(n);
console.log('');
console.log(`  ${w('metric', 26)} ${w('before', 10)} ${w('after', 10)} ${w('delta', 10)} ${w('delta %', 8)} verdict`);
for (const r of rows) {
  const sign = r.abs != null && r.abs > 0 ? '+' : '';
  console.log(`  ${w(r.label, 26)} ${w(r.before, 10)} ${w(r.after, 10)} ${w(r.abs == null ? 'n/a' : sign + r.abs, 10)} ${w(r.pct == null ? 'n/a' : sign + r.pct + '%', 8)} ${r.verdict}${r.unit ? '  (' + r.unit + ')' : ''}`);
}

const failedBefore = (before.outcome?.failed || []).join(',') || 'none';
const failedAfter = (after.outcome?.failed || []).join(',') || 'none';
console.log('');
console.log(`  checks  before: ${before.outcome?.pass ? 'PASS' : 'FAIL'} (failed: ${failedBefore})   after: ${after.outcome?.pass ? 'PASS' : 'FAIL'} (failed: ${failedAfter})`);
const better = rows.filter((r) => r.verdict === 'better').length;
const worse = rows.filter((r) => r.verdict === 'worse').length;
console.log(`  verdict ${better} better, ${worse} worse, ${rows.length - better - worse} same/noise`);

if (wantJson) {
  const out = path.join('../_runtime', `bench-diff-${before.label}-vs-${after.label}.json`);
  fs.writeFileSync(out, JSON.stringify({ schema: 'rr4.bench.diff/1', before: files[0], after: files[1], compat, rows, outcome: { better, worse } }, null, 2));
  console.log(`  WROTE ${out}`);
}
if (compatStrict && compat.length) process.exitCode = 1;
