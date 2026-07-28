// The forward-pass budget gate, automated — policy-bench.html in real Chrome,
// with the CPU throttled to stand in for a visitor's old laptop.
//
//   node tools/policy-bench.mjs                 # unthrottled
//   node tools/policy-bench.mjs --throttle 4    # the E2 budget condition
//   node tools/policy-bench.mjs --url http://localhost:8137
//
// Follows parity.mjs's arrangement exactly: Playwright is NOT a dependency of
// this project — it is asked for at runtime (npm i -g playwright) and drives
// your installed Chrome. The server is spawned here unless --url points at one
// already running. Results come off `window.__benchResults`, which the page
// publishes for exactly this purpose.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const throttle = Number(arg('throttle', 1));
const givenUrl = arg('url', null);

async function loadChromium() {
  try {
    return (await import('playwright')).chromium;
  } catch {
    console.error(
      'This gate needs Playwright, which is deliberately not a dependency here.\n' +
        '  npm i -g playwright\n' +
        'It drives your installed Chrome — no browser download needed.\n\n' +
        'Or by hand: open tools/policy-bench.html (npm run serve) with DevTools\n' +
        `CPU throttling set to ${throttle}×, and read the tables.`,
    );
    process.exit(2);
  }
}

const chromium = await loadChromium();

let server = null;
let origin = givenUrl?.replace(/\/$/, '');
if (!origin) {
  const port = 8140 + Math.floor(Math.random() * 100);
  server = spawn(process.execPath, [fileURLToPath(new URL('./serve.js', import.meta.url)), '--port', String(port)], {
    stdio: 'ignore',
  });
  origin = `http://localhost:${port}`;
  await new Promise((r) => setTimeout(r, 400));
}

const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage();
  if (throttle > 1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  }
  await page.goto(`${origin}/tools/policy-bench.html`);
  const results = await page.waitForFunction(() => window.__benchResults, null, { timeout: 300000 })
    .then((h) => h.jsonValue());

  const ms = (v) => `${v.toFixed(3)} ms`;
  console.log(`policy-bench in headless Chrome, CPU throttle ${throttle}×\n`);
  console.log(`shipped net, main thread:   p50 ${ms(results.main.p50)}  p99 ${ms(results.main.p99)}  (budget 1 ms)`);
  if (results.worker) {
    console.log(`shipped net, worker rtt:    p50 ${ms(results.worker.rtt.p50)}  p99 ${ms(results.worker.rtt.p99)}  (deadline 100 ms)`);
    console.log(`shipped net, worker compute: p99 ${ms(results.worker.compute.p99)}`);
  }
  console.log('\nE2 candidates (random weights, naive kernels — over-estimates):');
  for (const c of results.candidates) {
    const rtt = c.worker ? c.worker.rtt.p99 : NaN;
    const verdict = rtt < 100 ? `PASS ${(100 / rtt).toFixed(0)}× headroom` : 'FAIL';
    console.log(
      `  ${c.name.padEnd(12)} ${String((c.params / 1e3).toFixed(0)).padStart(4)}k params` +
      `  main p99 ${ms(c.main.p99)}  worker rtt p99 ${Number.isFinite(rtt) ? ms(rtt) : '—'}  ${verdict}`,
    );
  }
  if (throttle > 1) {
    console.log(
      '\nnote: CDP CPU throttling reaches the page\'s main thread but largely not worker\n' +
      'threads (compare worker compute across throttles). The conservative old-laptop\n' +
      'bound for worker COMPUTE is therefore the throttled MAIN-thread p99 — same\n' +
      'kernel, same slowdown assumption — with messaging on top.',
    );
  }
  console.log(`\n${results.ua}`);
} finally {
  await browser.close();
  server?.kill();
}
