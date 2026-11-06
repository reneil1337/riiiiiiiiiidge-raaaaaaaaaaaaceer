// Probe headless rAF cadence under different flags.
import puppeteer from 'puppeteer-core';
const BRAVE = 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe';
const cases = [
  { name: 'default', args: [] },
  { name: 'disable-frame-rate-limit', args: ['--disable-frame-rate-limit'] },
  { name: 'disable-gpu-vsync', args: ['--disable-gpu-vsync'] },
  { name: 'swiftshader', args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] },
  { name: 'old-headless', headless: 'shell', args: [] },
];
for (const c of cases) {
  let b;
  try {
    b = await puppeteer.launch({
      executablePath: BRAVE, headless: c.headless || 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage', ...c.args],
      defaultViewport: { width: 1280, height: 900 },
    });
    const p = await b.newPage();
    await p.goto('about:blank');
    const r = await p.evaluate(async () => {
      const t0 = performance.now(); let n = 0; let last = t0; const d = [];
      await new Promise((res) => {
        const loop = (t) => { n++; if (n > 1) d.push(t - last); last = t; if (t - t0 < 2000) requestAnimationFrame(loop); else res(); };
        requestAnimationFrame(loop);
      });
      d.sort((a, b) => a - b);
      return { fps: +(n / ((performance.now() - t0) / 1000)).toFixed(1), p50: +d[Math.floor(d.length / 2)].toFixed(2), p95: +d[Math.floor(d.length * 0.95)].toFixed(2) };
    });
    console.log(JSON.stringify({ case: c.name, ...r }));
  } catch (e) {
    console.log(JSON.stringify({ case: c.name, error: String(e).slice(0, 200) }));
  } finally { if (b) await b.close(); }
}
