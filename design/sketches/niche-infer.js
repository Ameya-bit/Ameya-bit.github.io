/**
 * niche-infer.js — vanilla-JS inference engine for the Niche char-level GPT.
 *
 * Runs the 4.9M-param model (fp16 weights, fp32 math) entirely client-side:
 * no runtime deps, works in the browser and in Node (for the parity test).
 * Matches niche_classes.py exactly: pre-LN blocks, causal attention with a
 * KV cache, exact-erf GELU, LayerNorm eps 1e-5.
 *
 * Interp hooks for the widget:
 *   model.lastAttn      — B5H0's attention over the context at the last step
 *   model.lastTopProbs  — top-k {char, p} for the last sampled character
 *
 * Bundle comes from export_niche_web.py (niche-web.json + niche-web.bin).
 */

const ATTN_LAYER = 5; // B5H0 — the induction head the widget visualizes
const ATTN_HEAD = 0;

// Curly quotes etc. appear in article text but not in the training corpus.
const CHAR_FIXES = {
  '‘': "'", '’': "'", '“': '"', '”': '"',
  '–': '-', '—': '--', '…': '...', ' ': ' ',
};

function halfToFloatTable() {
  const table = new Float32Array(65536);
  const buf = new ArrayBuffer(4);
  const u32 = new Uint32Array(buf);
  const f32 = new Float32Array(buf);
  for (let h = 0; h < 65536; h++) {
    const sign = (h & 0x8000) << 16;
    let exp = (h >> 10) & 0x1f;
    let mant = h & 0x3ff;
    if (exp === 0) {
      if (mant === 0) { u32[0] = sign; }
      else { // subnormal
        exp = 127 - 15 + 1;
        while ((mant & 0x400) === 0) { mant <<= 1; exp--; }
        mant &= 0x3ff;
        u32[0] = sign | (exp << 23) | (mant << 13);
      }
    } else if (exp === 31) {
      u32[0] = sign | 0x7f800000 | (mant << 13); // inf / nan
    } else {
      u32[0] = sign | ((exp - 15 + 127) << 23) | (mant << 13);
    }
    table[h] = f32[0];
  }
  return table;
}

function erf(x) {
  // Abramowitz & Stegun 7.1.26, |error| < 1.5e-7 — matches torch's exact GELU
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

const gelu = x => 0.5 * x * (1 + erf(x / Math.SQRT2));

/** y = W x + b, torch Linear layout: W is [dOut, dIn] row-major. */
function linear(W, b, x, dIn, dOut, y) {
  for (let o = 0; o < dOut; o++) {
    let acc = b[o];
    const row = o * dIn;
    for (let i = 0; i < dIn; i++) acc += W[row + i] * x[i];
    y[o] = acc;
  }
  return y;
}

function layerNorm(g, b, x, n, y) {
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) { const d = x[i] - mean; variance += d * d; }
  variance /= n;
  const inv = 1 / Math.sqrt(variance + 1e-5);
  for (let i = 0; i < n; i++) y[i] = (x[i] - mean) * inv * g[i] + b[i];
  return y;
}

function softmaxInPlace(x, n) {
  let max = -Infinity;
  for (let i = 0; i < n; i++) if (x[i] > max) max = x[i];
  let sum = 0;
  for (let i = 0; i < n; i++) { x[i] = Math.exp(x[i] - max); sum += x[i]; }
  for (let i = 0; i < n; i++) x[i] /= sum;
  return x;
}

export class NicheModel {
  /** Browser entry point: lazy-load the bundle (call on first "ask Niche"). */
  static async load(manifestUrl, binUrl, onProgress) {
    const manifest = await (await fetch(manifestUrl)).json();
    const res = await fetch(binUrl);
    const reader = res.body.getReader();
    const total = Number(res.headers.get('Content-Length')) || 0;
    const parts = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      received += value.length;
      if (onProgress && total) onProgress(received / total);
    }
    const bin = new Uint8Array(received);
    let at = 0;
    for (const p of parts) { bin.set(p, at); at += p.length; }
    return new NicheModel(manifest, bin.buffer);
  }

  constructor(manifest, arrayBuffer) {
    const table = halfToFloatTable();
    this.cfg = manifest.config;
    this.itos = manifest.itos;
    this.stoi = new Map(manifest.itos.map((c, i) => [c, i]));
    this.parity = manifest.parity;

    this.w = {};
    for (const t of manifest.tensors) {
      const numel = t.shape.reduce((a, b) => a * b, 1);
      const raw = new Uint16Array(arrayBuffer, t.offset, numel);
      const f = new Float32Array(numel);
      for (let i = 0; i < numel; i++) f[i] = table[raw[i]];
      this.w[t.name] = f;
    }

    const { n_embd: C, n_layers: L, block_size: B, vocab_size: V, n_head: H } = this.cfg;
    this.headSize = C / H;
    // KV caches: per layer, [block_size, n_embd] with heads packed head-major
    this.kCache = Array.from({ length: L }, () => new Float32Array(B * C));
    this.vCache = Array.from({ length: L }, () => new Float32Array(B * C));
    // scratch buffers (reused every token — no per-token allocation)
    this.x = new Float32Array(C);
    this.norm = new Float32Array(C);
    this.qkv = new Float32Array(3 * C);
    this.attOut = new Float32Array(C);
    this.proj = new Float32Array(C);
    this.hidden = new Float32Array(4 * C);
    this.scores = new Float32Array(B);
    this.logits = new Float32Array(V);
    this.reset();
  }

  reset() {
    this.tokens = [];   // full generated-so-far token ids (context + output)
    this.T = 0;         // tokens currently in the KV cache
    this.lastAttn = null;
    this.lastTopProbs = null;
  }

  /** Text -> ids. Fixes curly punctuation; silently drops chars Niche has never seen. */
  encode(text) {
    const ids = [];
    for (const ch of text) {
      const c = CHAR_FIXES[ch] ?? ch;
      for (const cc of c) {
        const id = this.stoi.get(cc) ?? this.stoi.get(cc.toLowerCase());
        if (id !== undefined) ids.push(id);
      }
    }
    return ids;
  }

  decode(ids) { return ids.map(i => this.itos[i]).join(''); }

  /** One token through the network; appends to KV cache, returns logits. */
  forwardToken(id) {
    const { n_embd: C, n_layers: L, n_head: H, vocab_size: V } = this.cfg;
    const hs = this.headSize;
    const scale = 1 / Math.sqrt(hs);
    const w = this.w;
    const pos = this.T;
    const x = this.x;

    const tok = w['token_embedding.weight'];
    const posE = w['pos_embedding.weight'];
    for (let i = 0; i < C; i++) x[i] = tok[id * C + i] + posE[pos * C + i];

    for (let layer = 0; layer < L; layer++) {
      const p = `blocks.${layer}.`;
      // --- attention sublayer ---
      layerNorm(w[p + 'ln1.weight'], w[p + 'ln1.bias'], x, C, this.norm);
      linear(w[p + 'comp_full_attend.qkv.weight'], w[p + 'comp_full_attend.qkv.bias'],
        this.norm, C, 3 * C, this.qkv);

      const kC = this.kCache[layer], vC = this.vCache[layer];
      kC.set(this.qkv.subarray(C, 2 * C), pos * C);
      vC.set(this.qkv.subarray(2 * C, 3 * C), pos * C);

      const T = pos + 1;
      for (let h = 0; h < H; h++) {
        const qOff = h * hs;
        for (let t = 0; t < T; t++) {
          let s = 0;
          const kOff = t * C + qOff;
          for (let j = 0; j < hs; j++) s += this.qkv[qOff + j] * kC[kOff + j];
          this.scores[t] = s * scale;
        }
        softmaxInPlace(this.scores, T);
        if (layer === ATTN_LAYER && h === ATTN_HEAD) {
          this.lastAttn = this.scores.slice(0, T); // for the widget's viz
        }
        for (let j = 0; j < hs; j++) {
          let acc = 0;
          for (let t = 0; t < T; t++) acc += this.scores[t] * vC[t * C + qOff + j];
          this.attOut[qOff + j] = acc;
        }
      }
      linear(w[p + 'comp_full_attend.lin_proj.weight'], w[p + 'comp_full_attend.lin_proj.bias'],
        this.attOut, C, C, this.proj);
      for (let i = 0; i < C; i++) x[i] += this.proj[i];

      // --- MLP sublayer ---
      layerNorm(w[p + 'ln2.weight'], w[p + 'ln2.bias'], x, C, this.norm);
      linear(w[p + 'ff.ff.0.weight'], w[p + 'ff.ff.0.bias'], this.norm, C, 4 * C, this.hidden);
      for (let i = 0; i < 4 * C; i++) this.hidden[i] = gelu(this.hidden[i]);
      linear(w[p + 'ff.ff.2.weight'], w[p + 'ff.ff.2.bias'], this.hidden, 4 * C, C, this.proj);
      for (let i = 0; i < C; i++) x[i] += this.proj[i];
    }

    layerNorm(w['ln_f.weight'], w['ln_f.bias'], x, C, this.norm);
    linear(w['last_layer.weight'], w['last_layer.bias'], this.norm, C, V, this.logits);
    this.T = pos + 1;
    return this.logits;
  }

  /** Feed a full prompt; on context overflow, keep the trailing half and rebuild. */
  prefill(ids) {
    let logits = null;
    for (const id of ids) {
      if (this.T >= this.cfg.block_size) this.rebuildWindow();
      logits = this.forwardToken(id);
      this.tokens.push(id);
    }
    return logits;
  }

  rebuildWindow() {
    const keep = this.tokens.slice(-(this.cfg.block_size >> 1));
    this.tokens = [];
    this.T = 0;
    for (const id of keep) { this.forwardToken(id); this.tokens.push(id); }
  }

  sample(logits, temperature = 0.8, topK = 40) {
    const V = this.cfg.vocab_size;
    const order = Array.from({ length: V }, (_, i) => i)
      .sort((a, b) => logits[b] - logits[a])
      .slice(0, topK);
    const probs = softmaxInPlace(Float32Array.from(order, i => logits[i] / temperature), topK);
    this.lastTopProbs = order.slice(0, 8).map((id, r) => ({ char: this.itos[id], p: probs[r] }));
    let r = Math.random();
    for (let i = 0; i < topK; i++) { r -= probs[i]; if (r <= 0) return order[i]; }
    return order[topK - 1];
  }

  /**
   * The "ask Niche" entry point. Streams chars via onChar(char, model) —
   * the widget reads lastAttn / lastTopProbs there for the live viz.
   * onChar may return a Promise (e.g. rAF) to yield to the UI thread.
   */
  async generate(promptText, nChars, { temperature = 0.8, topK = 40, onChar, greedy = false } = {}) {
    this.reset();
    let logits = this.prefill(this.encode(promptText));
    let out = '';
    for (let i = 0; i < nChars; i++) {
      if (this.T >= this.cfg.block_size) this.rebuildWindow();
      const id = greedy
        ? this.logits.indexOf(Math.max(...this.logits))
        : this.sample(logits, temperature, topK);
      const ch = this.itos[id];
      out += ch;
      if (onChar) await onChar(ch, this);
      logits = this.forwardToken(id);
      this.tokens.push(id);
    }
    return out;
  }
}
