// The clone's forward pass, by hand.
//
// Phase D of design/panda-policy-net.md. A ~122k-parameter transformer over the
// observation encoder's tokens, run on the main thread once per decision tick.
//
// ## Why hand-rolled
//
// At this size the runtimes are the slow option, not the fast one: onnxruntime-web
// ships ~10 MB of wasm before a single weight, and TF.js buys tensor bookkeeping and
// a leak discipline for a model whose entire forward pass is eleven matrix multiplies.
// A typed-array implementation is ~300 lines, allocates nothing per tick, and — the
// part that actually matters — is auditable against the Python side line by line,
// which is what the parity gate compares.
//
// ## The kernel
//
// Every matmul here is `out[M,N] = x[M,K] @ w[N,K]^T`, with the weights in PyTorch's
// own `[out, in]` layout. That is deliberate: it makes both operands stride-1 in the
// inner loop and keeps the accumulator in a register, and four accumulators break the
// dependency chain on the FP adder. Measured in this engine:
//
//   scatter-accumulate (weights [K,N])   3.2 GFLOP/s
//   dot product        (weights [N,K])   3.5 GFLOP/s
//   dot product, 4 accumulators          4.4 GFLOP/s
//
// which is the whole reason the model is 4 layers of d=48 rather than d=64 — see
// `trainer/py/model.py` for the budget table that shape came out of.
//
// ## Determinism
//
// A policy is not a bystander to the sim's determinism: its action goes into
// `step()`, so an engine that computed the attention softmax differently would
// diverge the episode. Everything here is +,-,*,/ and comparisons — which IEEE-754
// pins — plus `sqrt` (correctly rounded by mandate) and `mathx.exp` (pinned in
// Phase D for exactly this reason). ReLU rather than GELU for the same motive: a
// comparison cannot disagree across engines and a transcendental can.

import { exp, sqrt } from '../mathx.js';

// ---- the weights ----

// Decode the float16 blob into one Float32Array. Done once at load: the forward pass
// wants f32 lanes, and half-precision arithmetic does not exist in JS anyway.
//
// Integer bit-twiddling rather than `Float16Array` (not universal) or a `Math.pow`
// reconstruction (banned in engine code, and lossy for subnormals). Exact for every
// finite half, subnormals included.
export function decodeFloat16(bytes) {
  const half = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  const out = new Float32Array(half.length);
  const bits = new Uint32Array(1);
  const view = new Float32Array(bits.buffer);
  for (let i = 0; i < half.length; i++) {
    const h = half[i];
    const s = (h & 0x8000) << 16;
    const e = (h >> 10) & 0x1f;
    const m = h & 0x3ff;
    if (e === 0) {
      if (m === 0) { bits[0] = s; } else {
        // Subnormal half -> normal float: shift the mantissa up until its leading
        // 1 falls off, and dock the exponent by however many shifts that took.
        let mm = m;
        let ee = -1;
        do { mm <<= 1; ee += 1; } while ((mm & 0x400) === 0);
        bits[0] = s | ((127 - 15 - ee) << 23) | ((mm & 0x3ff) << 13);
      }
    } else if (e === 0x1f) {
      bits[0] = s | 0x7f800000 | (m << 13); // Inf / NaN
    } else {
      bits[0] = s | ((e - 15 + 127) << 23) | (m << 13);
    }
    out[i] = view[0];
  }
  return out;
}

// Slice the flat blob into named views. No copying — every tensor is a subarray of
// the one buffer, so the whole model is one allocation.
export function bindWeights(manifest, flat) {
  if (flat.length !== manifest.elements) {
    throw new Error(`policy: blob has ${flat.length} elements, manifest says ${manifest.elements}`);
  }
  const w = {};
  for (const t of manifest.tensors) {
    w[t.name] = flat.subarray(t.offset, t.offset + t.count);
  }
  return w;
}

// ---- kernels ----

// out[M,N] = x[M,K] @ w[N,K]^T + b[N].  `b` may be null.
function linear(out, x, w, b, M, K, N) {
  const K4 = K - (K & 3);
  for (let i = 0; i < M; i++) {
    const xo = i * K;
    const oo = i * N;
    for (let j = 0; j < N; j++) {
      const wo = j * K;
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let s3 = 0;
      for (let k = 0; k < K4; k += 4) {
        s0 += x[xo + k] * w[wo + k];
        s1 += x[xo + k + 1] * w[wo + k + 1];
        s2 += x[xo + k + 2] * w[wo + k + 2];
        s3 += x[xo + k + 3] * w[wo + k + 3];
      }
      let s = s0 + s1 + s2 + s3;
      for (let k = K4; k < K; k++) s += x[xo + k] * w[wo + k];
      out[oo + j] = b ? s + b[j] : s;
    }
  }
}

// Row-wise LayerNorm over the last axis. Mean and variance in the two-pass form:
// the one-pass sum-of-squares shortcut loses precision exactly where activations are
// large, and this is nine rows of 48.
function layerNorm(out, x, g, b, M, D, eps) {
  for (let i = 0; i < M; i++) {
    const o = i * D;
    let mean = 0;
    for (let k = 0; k < D; k++) mean += x[o + k];
    mean /= D;
    let varsum = 0;
    for (let k = 0; k < D; k++) {
      const d = x[o + k] - mean;
      varsum += d * d;
    }
    const inv = 1 / sqrt(varsum / D + eps);
    for (let k = 0; k < D; k++) out[o + k] = (x[o + k] - mean) * inv * g[k] + b[k];
  }
}

// Softmax in place over `n` contiguous lanes, max-shifted so `exp` never overflows.
function softmax(v, at, n) {
  let max = v[at];
  for (let i = 1; i < n; i++) if (v[at + i] > max) max = v[at + i];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const e = exp(v[at + i] - max);
    v[at + i] = e;
    sum += e;
  }
  const inv = 1 / sum;
  for (let i = 0; i < n; i++) v[at + i] *= inv;
}

// ---- the model ----

// Build a runner for one set of weights. Owns every buffer it needs, so `forward`
// allocates nothing — the RL loop and the page both call it at 10 Hz forever.
//
// Single-threaded by construction, like `makeObserver`: `forward` returns a view its
// own next call overwrites.
export function makeNet(manifest, flat) {
  const cfg = manifest.config;
  const w = bindWeights(manifest, flat);
  const { tokens: T, d_model: D, n_heads: H, d_ff: FF, n_layers: L, n_actions: A } = cfg;
  const DH = D / H;
  const DIN = cfg.obs_width * cfg.frames;
  const scale = 1 / sqrt(DH);

  // Every scratch buffer, once.
  const input = new Float32Array(T * DIN);
  const h = new Float32Array(T * D);
  const norm = new Float32Array(T * D);
  const qkv = new Float32Array(T * 3 * D);
  const att = new Float32Array(H * T * T);
  const heads = new Float32Array(T * D);
  const mixed = new Float32Array(T * D);
  const ff1 = new Float32Array(T * FF);
  const ff2 = new Float32Array(T * D);
  const tail = new Float32Array(D);
  const logits = new Float32Array(A);

  function block(i) {
    const p = `block.${i}.`;
    layerNorm(norm, h, w[`${p}ln1.weight`], w[`${p}ln1.bias`], T, D, cfg.ln_eps);
    linear(qkv, norm, w[`${p}qkv.weight`], w[`${p}qkv.bias`], T, D, 3 * D);

    // Attention, head by head. Unmasked: the tokens are pandas in a room, not a
    // sequence with a past — there is nothing for one to hide from another.
    for (let head = 0; head < H; head++) {
      const qAt = head * DH;
      const kAt = D + head * DH;
      const vAt = 2 * D + head * DH;
      const aAt = head * T * T;
      for (let i = 0; i < T; i++) {
        const qo = i * 3 * D + qAt;
        for (let j = 0; j < T; j++) {
          const ko = j * 3 * D + kAt;
          let s = 0;
          for (let k = 0; k < DH; k++) s += qkv[qo + k] * qkv[ko + k];
          att[aAt + i * T + j] = s * scale;
        }
        softmax(att, aAt + i * T, T);
        const ho = i * D + head * DH;
        for (let k = 0; k < DH; k++) heads[ho + k] = 0;
        for (let j = 0; j < T; j++) {
          const a = att[aAt + i * T + j];
          const vo = j * 3 * D + vAt;
          for (let k = 0; k < DH; k++) heads[ho + k] += a * qkv[vo + k];
        }
      }
    }

    linear(mixed, heads, w[`${p}proj.weight`], w[`${p}proj.bias`], T, D, D);
    for (let i = 0; i < T * D; i++) h[i] += mixed[i];

    layerNorm(norm, h, w[`${p}ln2.weight`], w[`${p}ln2.bias`], T, D, cfg.ln_eps);
    linear(ff1, norm, w[`${p}fc1.weight`], w[`${p}fc1.bias`], T, D, FF);
    for (let i = 0; i < T * FF; i++) if (ff1[i] < 0) ff1[i] = 0; // ReLU
    linear(ff2, ff1, w[`${p}fc2.weight`], w[`${p}fc2.bias`], T, FF, D);
    for (let i = 0; i < T * D; i++) h[i] += ff2[i];
  }

  // `frames` is a ring buffer of `cfg.frames` observation frames; `newest` is the
  // index of the most recent. Laid out into `input` as PyTorch's permute does:
  // token-major, and within a token the frames run most-recent-first.
  function gather(frames, newest) {
    const W = cfg.obs_width;
    for (let t = 0; t < T; t++) {
      for (let f = 0; f < cfg.frames; f++) {
        const src = frames[(newest - f + cfg.frames * 2) % cfg.frames];
        const from = t * W;
        const to = t * DIN + f * W;
        for (let k = 0; k < W; k++) input[to + k] = src[from + k];
      }
    }
  }

  // Frames in, 17 logits out. The readout is token 0 — the hat panda's own — after
  // attention has mixed every neighbour into it.
  function forward(frames, newest) {
    gather(frames, newest);
    linear(h, input, w['embed.weight'], w['embed.bias'], T, DIN, D);
    const pos = w.pos;
    for (let i = 0; i < T * D; i++) h[i] += pos[i];
    for (let i = 0; i < L; i++) block(i);
    layerNorm(tail, h, w['ln_f.weight'], w['ln_f.bias'], 1, D, cfg.ln_eps);
    linear(logits, tail, w['head.weight'], w['head.bias'], 1, D, A);
    return logits;
  }

  return { cfg, forward, logits };
}
