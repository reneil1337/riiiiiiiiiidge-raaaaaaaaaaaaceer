// Verify the built manual against the running cabinet.
//
//   cd docs
//   npm run build
//   npm run verify                 # uses http://localhost:8080
//   node scripts/verify.mjs http://<host-lan-ip>:8080
//
// Checks, in one pass:
//   - every built page answers 200 and has exactly one <h1> (client-redirect
//     stubs are allowed zero);
//   - every internal `/docs/...` link resolves (301 followed);
//   - the cabinet routes the manual links to still answer (/, /welcome, /play, ...);
//   - the section URLs 301 to their first page.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist', 'docs');
const BASE = (process.argv[2] || process.env.RR4_BASE || 'http://localhost:8080').replace(/\/+$/, '');

if (!fs.existsSync(DIST)) {
  console.error(`missing build: ${DIST} - run "npm run build" first`);
  process.exit(2);
}

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.html')) out.push(full);
  }
  return out;
};

const routes = walk(DIST).map((file) => {
  const rel = path.relative(DIST, file).split(path.sep).join('/');
  const src = fs.readFileSync(file, 'utf8');
  // Zudoku's section/index stubs are a one-line script redirect; everything else
  // is a real page. The cabinet 301s the bare section URLs, so a followed fetch
  // lands on the first page and must still have exactly one H1.
  const stub = src.length < 600 && /window\.location\.href\s*=/.test(src);
  if (rel === 'index.html') return { route: '/docs', file, stub };
  return { route: `/docs/${rel.replace(/\.html$/, '')}`, file, stub };
});

const APP_ROUTES = ['/', '/welcome', '/games', '/multiplayer', '/play', '/play-net', '/lobby', '/api/music'];
const SECTION_REDIRECTS = {
  '/docs/multiplayer': '/docs/multiplayer/lan',
  '/docs/games': '/docs/games/ridge-racer-type-4',
  '/docs/play': '/docs/play/browser',
  '/docs': '/docs/introduction',
};

const failures = [];
const fetchText = async (route) => {
  const res = await fetch(BASE + route, { redirect: 'follow' });
  return { status: res.status, text: await res.text() };
};

console.log(`verify ${BASE}  (${routes.length} pages)`);

const internal = new Set();
for (const { route, file, stub } of routes) {
  let status;
  let text = '';
  try {
    ({ status, text } = await fetchText(route));
  } catch (err) {
    failures.push(`${route} unreachable: ${err.message}`);
    continue;
  }
  const h1 = (text.match(/<h1[ >]/g) || []).length;
  const isStub = stub && /window\.location\.href\s*=/.test(text.slice(0, 1200));
  const h1ok = isStub ? h1 === 0 : h1 === 1;
  if (status !== 200) failures.push(`${route} -> HTTP ${status}`);
  if (!h1ok) failures.push(`${route} h1=${h1} (stub=${isStub})`);
  for (const m of text.matchAll(/href="(\/docs\/[^"#?]*)/g)) internal.add(m[1]);
  if (!isStub) console.log(`  ${status} h1=${h1} ${route}`);
}

for (const route of [...internal].sort()) {
  try {
    const res = await fetch(BASE + route, { redirect: 'follow' });
    if (res.status >= 400) failures.push(`link ${route} -> HTTP ${res.status}`);
  } catch (err) {
    failures.push(`link ${route} unreachable: ${err.message}`);
  }
}

for (const route of APP_ROUTES) {
  try {
    const res = await fetch(BASE + route, { redirect: 'follow' });
    if (res.status !== 200) failures.push(`app ${route} -> HTTP ${res.status}`);
  } catch (err) {
    failures.push(`app ${route} unreachable: ${err.message}`);
  }
}

for (const [from, to] of Object.entries(SECTION_REDIRECTS)) {
  try {
    const res = await fetch(BASE + from, { redirect: 'manual' });
    const loc = res.headers.get('location') || '';
    if (res.status !== 301 || !loc.endsWith(to)) failures.push(`redirect ${from} -> ${res.status} ${loc} (want 301 ${to})`);
  } catch (err) {
    failures.push(`redirect ${from} unreachable: ${err.message}`);
  }
}

console.log(`  ${internal.size} internal docs links checked`);
console.log(`  ${APP_ROUTES.length} app routes, ${Object.keys(SECTION_REDIRECTS).length} section redirects`);
if (failures.length) {
  console.log('');
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`\n${failures.length} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('\nOK - pages, links, app routes and redirects all resolve');
}
