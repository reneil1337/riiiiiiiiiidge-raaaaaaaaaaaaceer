// One command for the whole 2P evidence suite.
//
//   node verify-mp.mjs          # fast suites: /mp, lobby UI, shell, host macro
//   node verify-mp.mjs --full   # + the two-browser race (boots two R4 cores)
//   node verify-mp.mjs --list   # print the suite and exit
//
// Every suite is an existing harness under _server/ that writes its own
// _runtime/*.json. This wrapper only runs them in a sensible order and prints
// one table, so nobody has to remember five file names.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.RR4_BASE || 'http://localhost:8080';

const FAST = [
  { name: 'raw /mp transport', file: 'mp-ws-probe.mjs', evidence: '_runtime/mp-lobby-ws.json' },
  { name: '2P lounge UI + handoff', file: 'test-mp-lobby-ui.mjs', evidence: '_runtime/mp-lobby-ui.json' },
  { name: 'shell fullscreen + fill', file: 'test-shell-fs.mjs', evidence: '_runtime/shell-fs.json' },
  { name: 'host VS Battle macro', file: 'mp-macro-test.mjs', evidence: '_runtime/mp-macro-evidence.json' },
];
const FULL = [
  { name: 'two-browser race (P2)', file: 'test-mp-race-e2e.mjs', evidence: '_runtime/mp-race-e2e.json' },
];

const args = process.argv.slice(2);
const suites = args.includes('--full') ? [...FAST, ...FULL] : FAST;
if (args.includes('--list')) {
  for (const s of suites) console.log(`${s.file}\t${s.name}`);
  process.exit(0);
}

const checkServer = async () => {
  try {
    const res = await fetch(`${BASE}/api/health`, { cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
};

if (!(await checkServer())) {
  console.error(`cabinet not reachable at ${BASE} - start _server\\start-test.bat first`);
  process.exit(2);
}

console.log(`2P VERIFY (${args.includes('--full') ? 'full' : 'fast'})  base ${BASE}`);
console.log('');

const rows = [];
for (const suite of suites) {
  const started = Date.now();
  process.stdout.write(`... ${suite.name} (${suite.file})\n`);
  const run = spawnSync(process.execPath, [suite.file], {
    cwd: HERE,
    encoding: 'utf8',
    timeout: 900000,
    env: { ...process.env, RR4_BASE: BASE },
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  const pass = run.status === 0;
  // Pull the harness's own summary line if it printed one.
  const summary = output.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /checks?:|RESULT:|ALL CHECKS|passed \/|checks passed/i.test(l))
    .slice(-1)[0] || '';
  rows.push({ suite, pass, seconds, summary, output });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${suite.name}  ${seconds}s${summary ? '  ' + summary : ''}\n`);
  if (!pass) {
    const tail = output.split(/\r?\n/).filter(Boolean).slice(-12);
    for (const line of tail) console.log(`     ${line}`);
  }
}

const failed = rows.filter((r) => !r.pass);
console.log('');
console.log(`${rows.length - failed.length}/${rows.length} suites passed`);
for (const r of rows) console.log(`  ${r.pass ? 'OK  ' : 'FAIL'} ${r.suite.file.padEnd(26)} ${r.suite.evidence}`);
if (failed.length) {
  console.log('');
  console.log(`evidence for the failures: ${failed.map((f) => f.suite.evidence).join(', ')}`);
}
process.exitCode = failed.length ? 1 : 0;
