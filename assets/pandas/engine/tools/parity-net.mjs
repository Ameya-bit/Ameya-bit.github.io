// The Phase-D exit number: JS-vs-PyTorch action agreement at scale.
//
//   node tools/parity-net.mjs
//
// The committed 16-case fixture (test/net.test.js) catches wiring bugs. This reads
// the bulk arrays `trainer/py/reference.py` leaves behind — 24k frames, gitignored —
// and computes the figure the plan actually asks for: **> 99.9% agreement**.
//
// It also reports *where* the two sides disagree, because the interesting question is
// not the rate but the shape. Both engines do the same arithmetic in a different
// order and float addition is not associative, so logits differ by ~1e-6 and an
// argmax whose top two are inside that will flip. Those flips are harmless and they
// are the only kind allowed: a disagreement at a wide margin is a bug, and printing
// the margin distribution is what tells the two apart.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { makeNet, decodeFloat16 } from '../policy/net.js';

const WEIGHTS = join(dirname(dirname(fileURLToPath(import.meta.url))), 'policy', 'weights');
const need = ['policy.json', 'policy.bin', 'parity-bulk.json', 'parity-frames.f32', 'parity-logits.f32'];

for (const f of need) {
  if (!existsSync(join(WEIGHTS, f))) {
    console.error(`missing ${f} — run:  cd trainer/py && uv run python reference.py`);
    process.exit(1);
  }
}

const manifest = JSON.parse(readFileSync(join(WEIGHTS, 'policy.json'), 'utf8'));
const bulk = JSON.parse(readFileSync(join(WEIGHTS, 'parity-bulk.json'), 'utf8'));
if (bulk.weights !== manifest.digest) {
  console.error(`parity arrays were made against weights ${bulk.weights}, policy.bin is ${manifest.digest}`);
  process.exit(1);
}

const readF32 = (name) => {
  const buf = readFileSync(join(WEIGHTS, name));
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2);
};

const net = makeNet(manifest, decodeFloat16(new Uint8Array(readFileSync(join(WEIGHTS, 'policy.bin')))));
const frames = readF32('parity-frames.f32');
const refLogits = readF32('parity-logits.f32');

const [N, F, T, W] = bulk.frames;
const A = bulk.logits[1];
const frameLen = T * W;
const caseLen = F * frameLen;

// One ring, refilled per case. `newest = 0` means the k-th most recent frame lives at
// slot (F - k) % F — the same convention `forward` reads and the fixture test uses.
const ring = Array.from({ length: F }, () => new Float32Array(frameLen));

let agree = 0;
let worstLogit = 0;
const flips = [];
const t0 = process.hrtime.bigint();

for (let i = 0; i < N; i++) {
  const base = i * caseLen;
  for (let k = 0; k < F; k++) {
    ring[(F - k) % F].set(frames.subarray(base + k * frameLen, base + (k + 1) * frameLen));
  }
  const got = net.forward(ring, 0);
  const ref = refLogits.subarray(i * A, (i + 1) * A);

  let mine = 0;
  let theirs = 0;
  for (let a = 0; a < A; a++) {
    const d = Math.abs(got[a] - ref[a]);
    if (d > worstLogit) worstLogit = d;
    if (got[a] > got[mine]) mine = a;
    if (ref[a] > ref[theirs]) theirs = a;
  }
  if (mine === theirs) { agree += 1; continue; }
  flips.push({ i, mine, theirs, margin: Math.abs(ref[theirs] - ref[mine]) });
}

const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const rate = agree / N;

console.log(`parity: ${agree.toLocaleString()}/${N.toLocaleString()} actions agree — ` +
  `${(100 * rate).toFixed(4)}%   (bar: 99.9%)`);
console.log(`  largest single logit difference  ${worstLogit.toExponential(2)}`);
console.log(`  ${(ms / N * 1000).toFixed(0)} us per forward pass over the whole set`);

if (flips.length) {
  flips.sort((a, b) => b.margin - a.margin);
  const margins = flips.map((f) => f.margin);
  console.log(`  ${flips.length} disagreement(s); PyTorch's margin over the runner-up at each:`);
  console.log(`    max ${margins[0].toExponential(2)}   median ${margins[margins.length >> 1].toExponential(2)}`);
  // A flip at a margin far above the arithmetic noise is not a tie — it is a bug.
  const suspicious = flips.filter((f) => f.margin > 100 * worstLogit);
  if (suspicious.length) {
    console.log(`  ⚠ ${suspicious.length} flip(s) at a margin >100x the largest logit error — not a tie:`);
    for (const f of suspicious.slice(0, 5)) {
      console.log(`      case ${f.i}: js ${f.mine} vs torch ${f.theirs}, margin ${f.margin.toExponential(2)}`);
    }
  }
}

process.exitCode = rate >= 0.999 ? 0 : 1;
