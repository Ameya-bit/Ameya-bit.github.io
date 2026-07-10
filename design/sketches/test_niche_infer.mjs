/**
 * Parity + speed test for niche-infer.js against the PyTorch reference vectors
 * baked into the manifest by export_niche_web.py.
 *
 * Usage: node test_niche_infer.mjs <bundle-dir>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NicheModel } from './niche-infer.js';

const dir = process.argv[2] ?? 'niche-web-out';
const manifest = JSON.parse(readFileSync(join(dir, 'niche-web.json'), 'utf8'));
const bin = readFileSync(join(dir, 'niche-web.bin'));
const model = new NicheModel(manifest, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));

const { prompt, last_logits, greedy, greedy_chars } = manifest.parity;

// 1. logits parity after prefill
const logits = model.prefill(model.encode(prompt));
let maxDiff = 0;
for (let i = 0; i < last_logits.length; i++) {
  maxDiff = Math.max(maxDiff, Math.abs(logits[i] - last_logits[i]));
}
console.log(`logits parity: max |Δ| = ${maxDiff.toExponential(2)} ${maxDiff < 1e-2 ? 'PASS' : 'FAIL'}`);

// 2. greedy continuation parity
const jsGreedy = await model.generate(prompt, greedy_chars, { greedy: true });
console.log(`greedy parity: ${jsGreedy === greedy ? 'PASS' : `FAIL\n  torch: ${JSON.stringify(greedy)}\n  js:    ${JSON.stringify(jsGreedy)}`}`);

// 3. B5H0 attention sanity: rows are distributions
const attnSum = model.lastAttn.reduce((a, b) => a + b, 0);
console.log(`B5H0 attention sums to ${attnSum.toFixed(6)} over ${model.lastAttn.length} positions ${Math.abs(attnSum - 1) < 1e-4 ? 'PASS' : 'FAIL'}`);

// 4. speed: sampled generation, like the widget would run
const N = 200;
const t0 = performance.now();
const sampled = await model.generate(prompt + 'This says this because', N, { temperature: 0.8, topK: 40 });
const dt = (performance.now() - t0) / 1000;
console.log(`speed: ${N} chars in ${dt.toFixed(2)}s → ${(N / dt).toFixed(0)} chars/s`);
console.log(`sample: ${JSON.stringify(sampled.slice(0, 120))}…`);
