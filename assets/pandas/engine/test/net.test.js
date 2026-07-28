// The Phase-D parity gate: the JS forward pass against PyTorch's, on real frames.
//
// The exit criterion is action agreement > 99.9%. Both sides run the *same* float16
// weights — `export.py` rounds before anything else and `reference.py` reloads the
// exported file — so nothing here is measuring quantisation. What it measures is
// whether eleven hand-written matrix multiplies do what `torch.nn` does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { makeNet, decodeFloat16 } from '../policy/net.js';
import { loadPolicy } from '../policy/load.js';
import { makeObserver } from '../policy/obs.js';
import { ACTION } from '../actions.js';

const ENGINE = dirname(dirname(fileURLToPath(import.meta.url)));
const WEIGHTS = join(ENGINE, 'policy', 'weights');
// The committed fixture lives in trainer/parity — outside assets/, where a Quarto
// render cannot sweep it into _site (see reference.py's header).
const FIXTURE = join(ENGINE, '..', '..', '..', 'trainer', 'parity', 'parity-fixture.json');
const has = (f) => existsSync(join(WEIGHTS, f));
const read = (f) => JSON.parse(readFileSync(join(WEIGHTS, f), 'utf8'));
const blob = () => new Uint8Array(readFileSync(join(WEIGHTS, 'policy.bin')));

// Every test here needs the exported policy, which is a build artefact of
// `trainer/py`. Skipping rather than failing keeps the engine suite runnable in a
// checkout that has not trained anything — but the skip is loud.
const ready = has('policy.json') && has('policy.bin') && existsSync(FIXTURE);
const opts = ready ? {} : { skip: 'no exported policy — run trainer/py/export.py' };

test('float16 decode is exact for the values a weight file holds', () => {
  // Round-trip a spread through the same encoding numpy writes, including the two
  // edges an integer decoder gets wrong if it takes the fast path: subnormals, and
  // the smallest normal.
  const values = [0, -0, 1, -1, 0.5, -0.25, 65504, -65504, 6.103515625e-5, 5.960464477539063e-8, 1 / 3, -1e-4];
  const halves = new Uint16Array(values.length);
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  for (let i = 0; i < values.length; i++) {
    // Encode f32 -> f16 with round-to-nearest-even, the same rule numpy uses.
    f32[0] = values[i];
    const b = u32[0];
    const s = (b >>> 16) & 0x8000;
    const e = ((b >>> 23) & 0xff) - 127 + 15;
    const m = b & 0x7fffff;
    if (e <= 0) {
      const shift = 14 - e;
      const sub = (m | 0x800000) >>> shift;
      halves[i] = s | ((sub + 1) >>> 1);
    } else {
      let half = s | (e << 10) | (m >>> 13);
      if ((m & 0x1000) && ((m & 0x0fff) || (m >>> 13) & 1)) half += 1;
      halves[i] = half;
    }
  }
  const out = decodeFloat16(new Uint8Array(halves.buffer));
  for (let i = 0; i < values.length; i++) {
    // Every listed value is exactly representable as a half except 1/3 and -1e-4,
    // which must land within half-precision resolution of themselves.
    const tol = Math.abs(values[i]) * 1e-3 + 1e-9;
    assert.ok(Math.abs(out[i] - values[i]) <= tol, `${values[i]} decoded as ${out[i]}`);
  }
});

test('the exported manifest describes this engine\'s sensor', opts, () => {
  const manifest = read('policy.json');
  const observer = makeObserver(manifest.observation.params);
  const { net, warnings } = loadPolicy(manifest, blob(), { observer });
  assert.deepEqual(warnings, []);
  assert.equal(net.cfg.tokens, observer.layout.tokens);
  assert.equal(net.cfg.n_actions, ACTION.COUNT);
  assert.equal(manifest.bytes, 2 * manifest.elements);
  // The wire budget from the plan: weights <= ~400 KB.
  assert.ok(manifest.bytes <= 400 * 1024, `policy.bin is ${(manifest.bytes / 1024).toFixed(0)} KB`);
});

test('a mismatched observation layout is refused at load, not at runtime', opts, () => {
  const manifest = read('policy.json');
  const bad = { ...manifest, config: { ...manifest.config, obs_width: manifest.config.obs_width + 1 } };
  assert.throws(() => loadPolicy(bad, blob()), /wide tokens/);
  const oldLayout = { ...manifest, observation: { ...manifest.observation, version: 99 } };
  assert.throws(() => loadPolicy(oldLayout, blob()), /observation layout/);
});

test('JS logits match PyTorch on the committed fixture', opts, () => {
  const manifest = read('policy.json');
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  assert.equal(fixture.weights.digest, manifest.digest,
    'fixture was generated against different weights — re-run trainer/py/reference.py');

  const { net } = loadPolicy(manifest, blob());
  const { frames: F, tokens: T, obs_width: W } = manifest.config;

  // The fixture's `frames` is (frames x tokens) rows of `width`, most recent first.
  // `forward` reads a *ring*: with `newest = 0`, the frame from k decisions ago lives
  // at `(-k) mod F`, so the k-th fixture frame goes to slot `(F - k) % F` — not to
  // slot k, which would hand the model its history backwards and is exactly the kind
  // of wiring bug this gate exists to catch.
  const ring = Array.from({ length: F }, () => new Float32Array(T * W));
  const slotOf = (k) => (F - k) % F;

  let agree = 0;
  let worstLogit = 0;
  let worstGap = Infinity;
  for (const c of fixture.cases) {
    for (let k = 0; k < F; k++) {
      for (let t = 0; t < T; t++) ring[slotOf(k)].set(c.frames[k * T + t], t * W);
    }
    const got = net.forward(ring, 0);
    for (let a = 0; a < got.length; a++) {
      worstLogit = Math.max(worstLogit, Math.abs(got[a] - c.logits[a]));
    }
    const mine = argmax(got);
    const theirs = argmax(c.logits);
    if (mine === theirs) agree += 1;
    else {
      // A disagreement is only acceptable if it is a near-tie. Record how near.
      const sorted = [...c.logits].sort((x, y) => y - x);
      worstGap = Math.min(worstGap, sorted[0] - sorted[1]);
    }
  }
  assert.ok(worstLogit < 2e-3, `largest logit difference ${worstLogit.toExponential(2)}`);
  assert.equal(agree, fixture.cases.length,
    `argmax disagreed on ${fixture.cases.length - agree} of ${fixture.cases.length} ` +
    `(closest true margin ${worstGap.toExponential(2)})`);
});

function argmax(v) {
  let best = 0;
  for (let i = 1; i < v.length; i++) if (v[i] > v[best]) best = i;
  return best;
}

test('the forward pass allocates nothing per call and stays under budget', opts, () => {
  const manifest = read('policy.json');
  const { net } = loadPolicy(manifest, blob());
  const { frames: F, tokens: T, obs_width: W } = manifest.config;
  const ring = Array.from({ length: F }, () => new Float32Array(T * W).map((_, i) => (i % 7) / 7));

  // The returned view is the net's own buffer — a second call overwrites it. Pinned
  // because the seam copies from it and a future caller that keeps it must be told.
  const first = net.forward(ring, 0);
  assert.equal(first, net.logits);

  for (let i = 0; i < 200; i++) net.forward(ring, i % F);
  const t0 = process.hrtime.bigint();
  const iters = 500;
  for (let i = 0; i < iters; i++) net.forward(ring, i % F);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / iters;
  // The plan's budget is < 1 ms in-page. Node is not the page, so this is a smoke
  // ceiling with room; `tools/policy-bench.html` measures the real one.
  assert.ok(ms < 2, `forward pass ${ms.toFixed(3)} ms`);
  console.log(`      forward pass: ${(ms * 1000).toFixed(0)} us/call (node)`);
});
