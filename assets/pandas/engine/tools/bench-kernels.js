// E2's candidate memory architectures, as costed forward passes.
//
// Phase E may not hand the network its history (stacked frames are a fixed
// window, not a belief it carries — model.py's own warning), so the candidates
// here all *carry* state across decisions and are priced per decision, memory
// update included, before a single training step. Random weights, real shapes:
// a matmul does not care what the numbers are, so these times are the times.
//
// The three candidates, each on the same single-frame spatial transformer
// (4 layers × 9 panda tokens × d48 — the shipped geometry minus frame-stacking,
// which the carried state replaces):
//
//   gru-global   token-0 readout feeds one GRU (d96); the head reads [t0 ⊕ h].
//                The POPGym-legitimate fallback: one hidden state, no address.
//   gru-slot     every token carries its own GRU state (d48, shared weights),
//                fed back as part of that token's input next decision. Memory
//                with a per-panda address — the lit review's own criterion, the
//                probe target Phase G wants, and the overlay's natural feed.
//   kv-temporal  token-0 summaries stream into 2 KV-cached attention layers
//                over a 128-decision ring (≈13 s). GTrXL-lite; the cache makes
//                the window incremental, which is what Phase D's table demands
//                (full recompute at this context does not fit any budget).
//
// Naive kernels, deliberately: dot-product linears in the shipped [out, in]
// layout but without net.js's four-accumulator unrolling, so every number here
// is a mild *over*-estimate of what a tuned implementation costs. Pricing errs
// only in the safe direction. Math.exp rather than mathx.exp for the same
// reason a bench may: nothing here ships or needs cross-engine determinism.

import { Rng } from '../rng.js';

const TOKENS = 9;
const OBS_W = 37;
const D = 48;
const LAYERS = 4;
const HEADS = 4;
const DFF = 192;
const N_ACTIONS = 17;

// ---- pieces ----

function makeParamStore(seed) {
  const rng = new Rng(seed);
  let count = 0;
  const tensor = (n, scale = 0.05) => {
    count += n;
    const t = new Float32Array(n);
    for (let i = 0; i < n; i++) t[i] = (rng.float(-1, 1)) * scale;
    return t;
  };
  return { tensor, params: () => count };
}

// y = W·x + b, weights in [out, in] — the shipped layout, walked contiguously.
function linear(w, b, x, y, out, inw) {
  for (let o = 0; o < out; o++) {
    let acc = b[o];
    const row = o * inw;
    for (let i = 0; i < inw; i++) acc += w[row + i] * x[i];
    y[o] = acc;
  }
}

function layerNorm(g, b, x, at, width) {
  let mean = 0;
  for (let i = 0; i < width; i++) mean += x[at + i];
  mean /= width;
  let varr = 0;
  for (let i = 0; i < width; i++) { const d = x[at + i] - mean; varr += d * d; }
  const inv = 1 / Math.sqrt(varr / width + 1e-5);
  for (let i = 0; i < width; i++) x[at + i] = (x[at + i] - mean) * inv * g[i] + b[i];
}

function softmaxInPlace(x, at, n) {
  let max = -Infinity;
  for (let i = 0; i < n; i++) if (x[at + i] > max) max = x[at + i];
  let sum = 0;
  for (let i = 0; i < n; i++) { const e = Math.exp(x[at + i] - max); x[at + i] = e; sum += e; }
  for (let i = 0; i < n; i++) x[at + i] /= sum;
}

// The spatial transformer: `tokens` of `inWidth` in, `tokens` of D out.
function makeSpatial(store, inWidth) {
  const embedW = store.tensor(D * inWidth);
  const embedB = store.tensor(D);
  const pos = store.tensor(TOKENS * D);
  const blocks = [];
  for (let l = 0; l < LAYERS; l++) {
    blocks.push({
      ln1g: store.tensor(D), ln1b: store.tensor(D),
      qkvW: store.tensor(3 * D * D), qkvB: store.tensor(3 * D),
      projW: store.tensor(D * D), projB: store.tensor(D),
      ln2g: store.tensor(D), ln2b: store.tensor(D),
      fc1W: store.tensor(DFF * D), fc1B: store.tensor(DFF),
      fc2W: store.tensor(D * DFF), fc2B: store.tensor(D),
    });
  }

  const x = new Float32Array(TOKENS * D);
  const nrm = new Float32Array(TOKENS * D);
  const qkv = new Float32Array(TOKENS * 3 * D);
  const att = new Float32Array(TOKENS);
  const mix = new Float32Array(TOKENS * D);
  const ff = new Float32Array(DFF);
  const tokIn = new Float32Array(inWidth);
  const tokOut = new Float32Array(D);
  const DH = D / HEADS;

  // input: Float32Array(TOKENS × inWidth) -> Float32Array(TOKENS × D), reused.
  return (input) => {
    for (let t = 0; t < TOKENS; t++) {
      tokIn.set(input.subarray(t * inWidth, (t + 1) * inWidth));
      linear(embedW, embedB, tokIn, tokOut, D, inWidth);
      for (let i = 0; i < D; i++) x[t * D + i] = tokOut[i] + pos[t * D + i];
    }
    for (const b of blocks) {
      nrm.set(x);
      for (let t = 0; t < TOKENS; t++) layerNorm(b.ln1g, b.ln1b, nrm, t * D, D);
      for (let t = 0; t < TOKENS; t++) {
        linear(b.qkvW, b.qkvB, nrm.subarray(t * D, (t + 1) * D), qkv.subarray(t * 3 * D, (t + 1) * 3 * D), 3 * D, D);
      }
      mix.fill(0);
      for (let h = 0; h < HEADS; h++) {
        const ho = h * DH;
        for (let t = 0; t < TOKENS; t++) {
          for (let s = 0; s < TOKENS; s++) {
            let dot = 0;
            for (let i = 0; i < DH; i++) dot += qkv[t * 3 * D + ho + i] * qkv[s * 3 * D + D + ho + i];
            att[s] = dot / Math.sqrt(DH);
          }
          softmaxInPlace(att, 0, TOKENS);
          for (let s = 0; s < TOKENS; s++) {
            const w = att[s];
            for (let i = 0; i < DH; i++) mix[t * D + ho + i] += w * qkv[s * 3 * D + 2 * D + ho + i];
          }
        }
      }
      for (let t = 0; t < TOKENS; t++) {
        linear(b.projW, b.projB, mix.subarray(t * D, (t + 1) * D), tokOut, D, D);
        for (let i = 0; i < D; i++) x[t * D + i] += tokOut[i];
      }
      nrm.set(x);
      for (let t = 0; t < TOKENS; t++) {
        layerNorm(b.ln2g, b.ln2b, nrm, t * D, D);
        linear(b.fc1W, b.fc1B, nrm.subarray(t * D, (t + 1) * D), ff, DFF, D);
        for (let i = 0; i < DFF; i++) if (ff[i] < 0) ff[i] = 0;
        linear(b.fc2W, b.fc2B, ff, tokOut, D, DFF);
        for (let i = 0; i < D; i++) x[t * D + i] += tokOut[i];
      }
    }
    return x;
  };
}

// A GRU cell: h' = (1-z)·h + z·ĥ. Weights [out, in] like everything else.
function makeGru(store, dIn, dH) {
  const wz = store.tensor(dH * (dIn + dH)); const bz = store.tensor(dH);
  const wr = store.tensor(dH * (dIn + dH)); const br = store.tensor(dH);
  const wh = store.tensor(dH * (dIn + dH)); const bh = store.tensor(dH);
  const cat = new Float32Array(dIn + dH);
  const z = new Float32Array(dH);
  const r = new Float32Array(dH);
  const hh = new Float32Array(dH);
  const catR = new Float32Array(dIn + dH);
  const sig = (v) => 1 / (1 + Math.exp(-v));

  return (x, h) => {
    cat.set(x); cat.set(h, dIn);
    linear(wz, bz, cat, z, dH, dIn + dH);
    linear(wr, br, cat, r, dH, dIn + dH);
    catR.set(x);
    for (let i = 0; i < dH; i++) catR[dIn + i] = h[i] * sig(r[i]);
    linear(wh, bh, catR, hh, dH, dIn + dH);
    for (let i = 0; i < dH; i++) {
      const zi = sig(z[i]);
      h[i] = (1 - zi) * h[i] + zi * Math.tanh(hh[i]);
    }
    return h;
  };
}

// One KV-cached temporal attention layer over a ring of past summaries.
function makeTemporalLayer(store, d, window) {
  const ln1g = store.tensor(d); const ln1b = store.tensor(d);
  const qkvW = store.tensor(3 * d * d); const qkvB = store.tensor(3 * d);
  const projW = store.tensor(d * d); const projB = store.tensor(d);
  const ln2g = store.tensor(d); const ln2b = store.tensor(d);
  const fc1W = store.tensor(DFF * d); const fc1B = store.tensor(DFF);
  const fc2W = store.tensor(d * DFF); const fc2B = store.tensor(d);

  const keys = new Float32Array(window * d);
  const vals = new Float32Array(window * d);
  let filled = 0;
  let at = 0;

  const nrm = new Float32Array(d);
  const qkv = new Float32Array(3 * d);
  const att = new Float32Array(window);
  const mixed = new Float32Array(d);
  const ff = new Float32Array(DFF);
  const tmp = new Float32Array(d);
  const DH = d / HEADS;

  const reset = () => { filled = 0; at = 0; };

  // x (d) -> x' (d), the cache advanced by one entry. In place.
  const step = (x) => {
    nrm.set(x); layerNorm(ln1g, ln1b, nrm, 0, d);
    linear(qkvW, qkvB, nrm, qkv, 3 * d, d);
    keys.set(qkv.subarray(d, 2 * d), at * d);
    vals.set(qkv.subarray(2 * d, 3 * d), at * d);
    at = (at + 1) % window;
    if (filled < window) filled += 1;

    mixed.fill(0);
    for (let h = 0; h < HEADS; h++) {
      const ho = h * DH;
      for (let s = 0; s < filled; s++) {
        let dot = 0;
        for (let i = 0; i < DH; i++) dot += qkv[ho + i] * keys[s * d + ho + i];
        att[s] = dot / Math.sqrt(DH);
      }
      softmaxInPlace(att, 0, filled);
      for (let s = 0; s < filled; s++) {
        const w = att[s];
        for (let i = 0; i < DH; i++) mixed[ho + i] += w * vals[s * d + ho + i];
      }
    }
    linear(projW, projB, mixed, tmp, d, d);
    for (let i = 0; i < d; i++) x[i] += tmp[i];

    nrm.set(x); layerNorm(ln2g, ln2b, nrm, 0, d);
    linear(fc1W, fc1B, nrm, ff, DFF, d);
    for (let i = 0; i < DFF; i++) if (ff[i] < 0) ff[i] = 0;
    linear(fc2W, fc2B, ff, tmp, d, DFF);
    for (let i = 0; i < d; i++) x[i] += tmp[i];
    return x;
  };

  return { step, reset };
}

// ---- the candidates ----

export function makeCandidates(seed = 20260728) {
  const out = [];

  {
    const store = makeParamStore(seed);
    const spatial = makeSpatial(store, OBS_W);
    const gru = makeGru(store, D, 96);
    const headW = store.tensor(N_ACTIONS * (D + 96)); const headB = store.tensor(N_ACTIONS);
    const h = new Float32Array(96);
    const cat = new Float32Array(D + 96);
    const logits = new Float32Array(N_ACTIONS);
    out.push({
      name: 'gru-global',
      what: 'single-frame spatial + one GRU d96; the fallback',
      params: store.params(),
      reset: () => h.fill(0),
      step(frame) {
        const x = spatial(frame);
        gru(x.subarray(0, D), h);
        cat.set(x.subarray(0, D)); cat.set(h, D);
        linear(headW, headB, cat, logits, N_ACTIONS, D + 96);
        return logits;
      },
    });
  }

  {
    const store = makeParamStore(seed + 1);
    const memW = 48;
    const spatial = makeSpatial(store, OBS_W + memW);
    const gru = makeGru(store, D, memW);
    const headW = store.tensor(N_ACTIONS * (D + memW)); const headB = store.tensor(N_ACTIONS);
    const mem = new Float32Array(TOKENS * memW);
    const input = new Float32Array(TOKENS * (OBS_W + memW));
    const cat = new Float32Array(D + memW);
    const logits = new Float32Array(N_ACTIONS);
    out.push({
      name: 'gru-slot',
      what: 'per-token GRU d48, fed back into that token next decision',
      params: store.params(),
      reset: () => mem.fill(0),
      step(frame) {
        for (let t = 0; t < TOKENS; t++) {
          input.set(frame.subarray(t * OBS_W, (t + 1) * OBS_W), t * (OBS_W + memW));
          input.set(mem.subarray(t * memW, (t + 1) * memW), t * (OBS_W + memW) + OBS_W);
        }
        const x = spatial(input);
        for (let t = 0; t < TOKENS; t++) {
          gru(x.subarray(t * D, (t + 1) * D), mem.subarray(t * memW, (t + 1) * memW));
        }
        cat.set(x.subarray(0, D)); cat.set(mem.subarray(0, memW), D);
        linear(headW, headB, cat, logits, N_ACTIONS, D + memW);
        return logits;
      },
    });
  }

  {
    const store = makeParamStore(seed + 2);
    const WINDOW = 128;
    const spatial = makeSpatial(store, OBS_W);
    const t1 = makeTemporalLayer(store, D, WINDOW);
    const t2 = makeTemporalLayer(store, D, WINDOW);
    const headW = store.tensor(N_ACTIONS * D); const headB = store.tensor(N_ACTIONS);
    const summary = new Float32Array(D);
    const logits = new Float32Array(N_ACTIONS);
    out.push({
      name: 'kv-temporal',
      what: `2 KV-cached attention layers over a ${WINDOW}-decision ring (~13 s)`,
      params: store.params(),
      reset: () => { t1.reset(); t2.reset(); },
      step(frame) {
        const x = spatial(frame);
        summary.set(x.subarray(0, D));
        t1.step(summary);
        t2.step(summary);
        linear(headW, headB, summary, logits, N_ACTIONS, D);
        return logits;
      },
    });
  }

  return out;
}
