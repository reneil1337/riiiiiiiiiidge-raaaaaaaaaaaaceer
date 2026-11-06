// Static host for the standalone netplay harness (port 3011).
// Run: node serve-test.mjs
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3011);
const app = express();

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(here, { extensions: ['html'], index: 'test-page.html' }));
// Read-only access to the real disc/BIOS for the PSX smoke test.
app.use('/disc', express.static('../../disc', { acceptRanges: true }));
app.use('/root', express.static('../..', { acceptRanges: true }));
app.use('/bios', express.static('../../_server/game/bios', { acceptRanges: true }));
app.get('/health', (req, res) => res.json({ ok: true, service: 'rr4-netplay-harness', port }));
app.get('/', (req, res) => res.sendFile(path.join(here, 'test-page.html')));

app.listen(port, '0.0.0.0', () => console.log(`netplay harness on http://0.0.0.0:${port}/`));
