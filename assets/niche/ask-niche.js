/**
 * Ask Niche — the panel widget. Wires the real model (niche-infer.js) into a
 * squircle → panel UI: attention stripes on top, output middle, input bottom.
 *
 * Desktop-only (pointer: fine, >700px). Weights (9.8 MB fp16) lazy-load on the
 * first ask; the browser HTTP cache covers repeat visits.
 *
 * Attention stripes show B5H0 live per generated character; once generation
 * completes they settle on the AVERAGE attention across all steps (per Ameya —
 * the final char's pattern alone is not representative).
 */
import { NicheModel } from './niche-infer.js';

const BASE = '/assets/niche';
const PRIME = 'This says this because ';
const MAX_INPUT = 200;
const MIN_CHARS = 160;   // then stop at the first sentence end
const MAX_CHARS = 280;
const CHAR_DELAY_MS = 33; // ~26 chars/s with compute; engine itself does ~177/s
// The attention strip's ink is read from the palette rather than written as a
// literal — a hardcoded rgb() is one more place the tokens can silently drift
// from styles.scss. Falls back to the ink it has always used if the custom
// property is missing, so the strip can never render invisible.
const INK = (() => {
  const hex = getComputedStyle(document.documentElement)
    .getPropertyValue('--gray-1200')
    .trim();
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [1, 2, 3].map(i => parseInt(m[i], 16)).join(',') : '33,32,28';
})();

// Always build the DOM; the CSS media queries (pointer: coarse / ≤700px)
// own visibility, so resizes and zoom changes behave correctly. Only skip
// entirely where there is no fine pointer at all (pure touch devices).
if (matchMedia('(pointer: fine)').matches) init();

function init() {
  document.body.insertAdjacentHTML('beforeend', `
    <button class="niche-chip" hidden>ask Niche</button>
    <button class="niche-fab" aria-expanded="false" aria-label="Ask Niche">ask Niche</button>
    <div class="niche-panel" role="dialog" aria-label="Ask Niche" data-closed="true">
      <header>
        <span class="niche-name">N&#776; Niche</span>
        <button class="niche-close" aria-label="Close">&times;</button>
      </header>
      <div class="niche-attn">
        <canvas></canvas>
        <div class="niche-cap">B5H0 attention over your passage &mdash; waiting</div>
      </div>
      <div class="niche-dl" hidden>
        <div class="niche-bar"><div class="niche-fill"></div></div>
        <div class="niche-lbl">waking Niche</div>
      </div>
      <div class="niche-out"><span class="niche-idle">Select a passage in the post, or paste one below, and Niche will explain it. Niche will not explain it well.</span></div>
      <div class="niche-in">
        <textarea maxlength="${MAX_INPUT}" placeholder="a passage for Niche to consider&hellip;" aria-label="Passage for Niche"></textarea>
        <div class="niche-row">
          <span class="niche-count">0/${MAX_INPUT}</span>
          <button class="niche-ask">ask Niche</button>
        </div>
      </div>
    </div>`);

  const $ = sel => document.querySelector(sel);
  const fab = $('.niche-fab');
  const panel = $('.niche-panel');
  const chip = $('.niche-chip');
  const closeBtn = $('.niche-close');
  const strip = $('.niche-attn canvas');
  const cap = $('.niche-cap');
  const dl = $('.niche-dl');
  const dlFill = $('.niche-fill');
  const dlLbl = $('.niche-lbl');
  const out = $('.niche-out');
  const input = $('.niche-in textarea');
  const count = $('.niche-count');
  const askBtn = $('.niche-ask');

  /* ----- open / close ----- */
  function openPanel(withText) {
    panel.dataset.closed = 'false';
    fab.dataset.open = 'true';
    fab.setAttribute('aria-expanded', 'true');
    if (withText) { input.value = withText.slice(0, MAX_INPUT); syncCount(); }
    input.focus();
  }
  function closePanel() {
    panel.dataset.closed = 'true';
    fab.dataset.open = 'false';
    fab.setAttribute('aria-expanded', 'false');
    fab.focus();
  }
  fab.addEventListener('click', () => openPanel());
  closeBtn.addEventListener('click', closePanel);
  addEventListener('keydown', e => {
    if (e.key === 'Escape' && panel.dataset.closed === 'false') closePanel();
  });

  /* ----- selection chip (article body only) ----- */
  const article = document.querySelector('#quarto-content main.content');
  if (article) {
    document.addEventListener('pointerup', () => setTimeout(() => {
      const sel = getSelection();
      const text = sel ? sel.toString().trim() : '';
      if (text.length > 12 && sel.rangeCount && article.contains(sel.anchorNode)) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        chip.style.left = `${scrollX + r.left + r.width / 2 - 40}px`;
        chip.style.top = `${scrollY + r.top - 38}px`;
        chip.hidden = false;
        chip.dataset.text = text;
      } else chip.hidden = true;
    }, 0));
    chip.addEventListener('click', () => {
      chip.hidden = true;
      openPanel(chip.dataset.text);
    });
  }

  /* ----- input ----- */
  function syncCount() { count.textContent = `${input.value.length}/${MAX_INPUT}`; }
  input.addEventListener('input', syncCount);

  /* ----- attention stripes ----- */
  function drawStripes(weights) {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const W = strip.clientWidth, H = 44;
    strip.width = Math.round(W * dpr);
    strip.height = Math.round(H * dpr);
    const c = strip.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const n = weights.length;
    if (!n) return;
    let max = 0;
    for (let j = 0; j < n; j++) if (weights[j] > max) max = weights[j];
    if (max <= 0) return;
    const bw = W / n;
    for (let j = 0; j < n; j++) {
      const rel = weights[j] / max;
      const h = 3 + rel * (H - 3);
      c.fillStyle = `rgba(${INK},${0.12 + rel * 0.78})`;
      c.fillRect(j * bw, H - h, Math.max(1, bw - 0.5), h);
    }
  }

  /* ----- model (lazy) ----- */
  let model = null;
  async function ensureModel() {
    if (model) return model;
    dl.hidden = false;
    model = await NicheModel.load(`${BASE}/niche-web.json`, `${BASE}/niche-web.bin`, frac => {
      dlFill.style.width = `${Math.round(frac * 100)}%`;
      dlLbl.textContent = `waking Niche — ${(frac * 9.8).toFixed(1)} / 9.8 MB (one time)`;
    });
    dl.hidden = true;
    return model;
  }

  /* ----- ask ----- */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let busy = false;

  async function runAsk() {
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true;
    askBtn.disabled = true;
    try {
      const m = await ensureModel();

      out.innerHTML = '';
      const primeEl = document.createElement('span');
      primeEl.className = 'niche-prime';
      primeEl.textContent = PRIME;
      const genEl = document.createElement('span');
      const caret = document.createElement('span');
      caret.className = 'niche-caret';
      caret.textContent = '▍';
      out.append(primeEl, genEl, caret);
      cap.textContent = 'B5H0 attention over your passage — live';

      m.reset();
      let logits = m.prefill(m.encode(text + '\n\n' + PRIME));

      // Average accumulator, indexed by absolute token position (stable
      // across sliding-window rebuilds).
      let sums = new Float32Array(0);
      let steps = 0;
      function accumulate() {
        const w = m.lastAttn;
        if (!w) return;
        const offset = m.tokens.length - w.length;
        const need = offset + w.length;
        if (need > sums.length) {
          const grown = new Float32Array(need);
          grown.set(sums);
          sums = grown;
        }
        for (let t = 0; t < w.length; t++) sums[offset + t] += w[t];
        steps++;
      }

      let generated = '';
      for (let i = 0; i < MAX_CHARS; i++) {
        if (m.T >= m.cfg.block_size) m.rebuildWindow();
        const id = m.sample(logits, 0.8, 40);
        const ch = m.itos[id];
        generated += ch;
        genEl.textContent = generated;
        out.scrollTop = out.scrollHeight;
        logits = m.forwardToken(id);
        m.tokens.push(id);
        accumulate();
        drawStripes(m.lastAttn);
        if (generated.length >= MIN_CHARS && /[.!?]/.test(ch)) break;
        await sleep(CHAR_DELAY_MS);
      }

      caret.remove();
      if (steps > 0) {
        const avg = new Float32Array(sums.length);
        for (let j = 0; j < sums.length; j++) avg[j] = sums[j] / steps;
        drawStripes(avg);
        cap.textContent = `B5H0 attention — averaged over ${steps} characters`;
      }
    } catch (err) {
      out.innerHTML = '<span class="niche-idle">Niche could not be woken. It would call this fate; it is probably the network.</span>';
      dl.hidden = true;
      model = null; // allow retry
      console.error('ask-niche:', err);
    } finally {
      busy = false;
      askBtn.disabled = false;
    }
  }
  askBtn.addEventListener('click', runAsk);
}
