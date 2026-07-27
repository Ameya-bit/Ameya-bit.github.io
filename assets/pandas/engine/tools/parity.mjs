// The Phase-A acceptance gate, automated: is the browser's sim the same machine
// as Node's, bit for bit?
//
// It runs the 32-seed golden trace on both sides and compares batch digests:
// Node in this process, the browser by loading tools/golden.html in real Chrome.
// A mismatch is bisected down to the exact seed and tick, and the diverging
// encode slots are printed — which is how the Math.sin ULP difference between
// Node 25 and Chrome was found (see the header of mathx.js).
//
//   npm run serve                     # in another shell
//   node tools/parity.mjs             # 10k ticks, headless Chrome
//   node tools/parity.mjs --ticks 50000 --url http://localhost:8137
//
// Playwright is NOT a dependency of this project (the engine and its tests stay
// zero-dep). This script asks for it at runtime and explains itself if it is
// missing — it is a gate you run deliberately, not part of `node --test`.

import { runTrace, runSeed, PHASE_A_SEEDS, firstDivergence } from './trace.js';
import { hex } from './checksum.js';
import * as engine from '../engine.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const ticks = Number(arg('ticks', 10000));
const origin = arg('url', 'http://localhost:8137').replace(/\/$/, '');

async function loadChromium() {
  try {
    return (await import('playwright')).chromium;
  } catch {
    console.error(
      'This gate needs Playwright, which is deliberately not a dependency here.\n' +
        'Run it from anywhere that has one:\n' +
        '  npm i -g playwright   (or npx playwright ...)\n' +
        'It drives your installed Chrome — no browser download needed.\n\n' +
        'Or do it by hand: open ' + origin + '/tools/golden.html?ticks=' + ticks + '\n' +
        'and check its batch digest against `node tools/golden.js --engine ./engine.js`.',
    );
    process.exit(2);
  }
}

// Walk the seeds until one diverges, then report where and in which state slot.
async function bisect(page) {
  for (const seed of PHASE_A_SEEDS) {
    const node = Array.from(runSeed({ engine, seed, ticks, keepStream: true }).stream);
    const web = await page.evaluate(
      async ({ seed: s, ticks: t, origin: o }) => {
        const trace = await import(`${o}/tools/trace.js`);
        const eng = await import(`${o}/engine.js`);
        return Array.from(trace.runSeed({ engine: eng, seed: s, ticks: t, keepStream: true }).stream);
      },
      { seed, ticks, origin },
    );
    const at = firstDivergence(node, web);
    if (at === -1) continue;

    console.error(`\nfirst divergence: seed ${seed}, tick ${at}`);
    let state = engine.init(seed);
    for (let i = 0; i < at - 1; i++) state = engine.step(state);
    const nodeAfter = engine.encode(engine.step(state));
    const webAfter = await page.evaluate(
      async ({ seed: s, at: a, origin: o }) => {
        const eng = await import(`${o}/engine.js`);
        let st = eng.init(s);
        for (let i = 0; i < a - 1; i++) st = eng.step(st);
        return eng.encode(eng.step(st));
      },
      { seed, at, origin },
    );
    const diffs = nodeAfter
      .map((v, i) => ({ slot: i, node: v, browser: webAfter[i] }))
      .filter((d) => d.node !== d.browser);
    console.error(`differing encode slots (${diffs.length}):`);
    for (const d of diffs.slice(0, 12)) console.error(`  [${d.slot}] node ${d.node}  browser ${d.browser}`);
    return false;
  }
  console.error('\nno per-seed divergence found — the mismatch is in the batch fold itself.');
  return false;
}

const chromium = await loadChromium();
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));

const url = `${origin}/tools/golden.html?ticks=${ticks}`;
try {
  await page.goto(url, { waitUntil: 'load' });
} catch {
  console.error(`could not load ${url} — is \`npm run serve\` running?`);
  await browser.close();
  process.exit(2);
}

const browserBatch = await page
  .waitForFunction(() => window.__goldenBatch, null, { timeout: 300000 })
  .then((h) => h.jsonValue());
const nodeBatch = hex(runTrace({ engine, seeds: PHASE_A_SEEDS, ticks }).batch);

console.log(`seeds ${PHASE_A_SEEDS.length} x ${ticks} ticks`);
console.log(`  node:    ${nodeBatch}`);
console.log(`  browser: ${browserBatch}`);
if (problems.length) console.log(`  page errors: ${problems.join(' | ')}`);

let ok = nodeBatch === browserBatch;
if (ok) console.log('\nPARITY OK — the browser is running the same machine as Node.');
else ok = await bisect(page);

await browser.close();
process.exit(ok ? 0 : 1);
