// The belief overlay — the window that makes a mind visible.
//
// The site-first goal (design/panda-policy-net.md, reframed 2026-07-28) has a hard
// problem attached: a policy that *works* is behaviourally indistinguishable from
// the rules watcher to anyone but Ameya, and a world model is a belief state inside
// a residual stream — invisible by construction. The overlay is the answer: a chip
// beside each panda saying what something believes about it. Phase G's probes are
// the intended tenant ("thinks that one's a sleeper, ~6 s left"); until they exist,
// the ground-truth provider below rents the space, which is what lets the visual
// design, the positioning and the cost all be built and judged now.
//
// ## The provider seam
//
// A provider is `{ describe, init(ctx) -> read(state) -> chips }`, mirroring the
// policy seam's own shape. A chip is:
//
//   { id,        a stable key — the entity id it hangs over
//     x, y,      stage coordinates (the entity's drawn position)
//     label,     one word, what is believed
//     detail,    optional second line ("~6s", a confidence)
//     tone }     'danger' | 'safe' | 'down' | 'note' — the accent class
//
// `read` is called once per engine tick (20 Hz), never per frame: chips step with
// the sim rather than gliding with the renderer, which is honest about what they
// are (a readout, not a character) and keeps the cost irrelevant. Everything is
// keyed by `id`, so a chip whose text did not change costs no DOM write at all.
//
// **The source badge is not decoration.** The corner tag names which provider is
// talking — "ground truth" today, "decoded belief" after Phase G — because the
// whole point of the eventual page is the difference between those two, and a
// reader must never mistake one for the other.

import { MODE, MODE_NAME, KNOCK } from '../state.js';

// ---- providers ----

// What the sim knows to be true, read straight off the state. The dev stand-in for
// the probe provider: same chips, unarguable source. Deliberately only labels what
// a *belief* would be about — anomalies, downed pandas, the set pieces — rather
// than every wanderer, so the field stays readable at a glance.
export function truthProvider() {
  return {
    describe: 'ground truth',
    init() {
      return function read(state) {
        const chips = [];
        for (const e of state.entities) {
          const chip = truthChip(e);
          if (chip) chips.push(chip);
        }
        return chips;
      };
    },
  };
}

// The flagship pair gets the flagship treatment: a sleeper and a freshly-knocked
// panda share their drawn cels byte for byte (pinned by an engine test), and the
// whole point of the memory project is telling them apart — so the truth overlay
// makes the distinction loud, as the belief overlay one day should.
function truthChip(e) {
  const base = { id: e.id, x: e.x, y: e.y };
  switch (e.mode) {
    case MODE.WANDER:
    case MODE.OBSERVING:
    case MODE.ENTERING:
      return null; // nothing worth believing about
    case MODE.SLEEPER:
      return { ...base, label: 'sleeper', tone: 'safe' };
    case MODE.KNOCKED:
      return { ...base, label: 'knocked', tone: 'down' };
    case MODE.ZOOMIES:
    case MODE.TUMBLER:
      return { ...base, label: MODE_NAME[e.mode], tone: 'danger' };
    case MODE.ROLLING:
      return { ...base, label: 'dive-roll', tone: 'note' };
    default:
      return { ...base, label: MODE_NAME[e.mode] ?? `mode ${e.mode}`, tone: 'note' };
  }
}

// A panda that is grounded for a non-mode reason (mid fall inside another mode's
// FSM) still reads as down; exported for providers that want the distinction.
export function isGroundedTail(e) {
  return e.knock !== KNOCK.NONE;
}

// ---- the layer ----

// Where the chip hangs relative to the entity's (x, y): centred over the sprite.
const CHIP_X = 50; // half the 100 px wrapper
const CHIP_Y = -6;

/**
 * Mount the overlay on a stage. The host calls `sync(state)` after each stepped
 * tick and `destroy()` on teardown; everything else is internal.
 *
 * @param {HTMLElement} stage
 * @param {object} provider  `{ describe, init(ctx) -> read(state) -> chips }`
 */
export function makeOverlay(stage, provider) {
  const layer = document.createElement('div');
  layer.className = 'belief_layer';
  const badge = document.createElement('div');
  badge.className = 'belief_badge';
  badge.textContent = `overlay: ${provider.describe ?? 'unnamed provider'}`;
  layer.appendChild(badge);
  stage.appendChild(layer);

  let read = null;
  const nodes = new Map(); // id -> { el, labelEl, detailEl, label, detail, tone }

  function ensure(id) {
    let n = nodes.get(id);
    if (n) return n;
    const el = document.createElement('div');
    el.className = 'belief_chip';
    const labelEl = document.createElement('span');
    const detailEl = document.createElement('span');
    detailEl.className = 'belief_detail';
    el.append(labelEl, detailEl);
    layer.appendChild(el);
    n = { el, labelEl, detailEl, label: null, detail: null, tone: null };
    nodes.set(id, n);
    return n;
  }

  return {
    sync(state) {
      if (!state) return;
      read = read ?? provider.init({ cfg: state.cfg });
      const chips = read(state);

      const seen = new Set();
      for (const c of chips) {
        seen.add(c.id);
        const n = ensure(c.id);
        n.el.style.transform = `translate(${(c.x + CHIP_X).toFixed(1)}px, ${(c.y + CHIP_Y).toFixed(1)}px)`;
        if (c.label !== n.label) { n.labelEl.textContent = c.label; n.label = c.label; }
        const detail = c.detail ?? '';
        if (detail !== n.detail) { n.detailEl.textContent = detail; n.detail = detail; }
        const tone = c.tone ?? 'note';
        if (tone !== n.tone) { n.el.dataset.tone = tone; n.tone = tone; }
      }
      for (const [id, n] of nodes) {
        if (!seen.has(id)) { n.el.remove(); nodes.delete(id); }
      }
    },
    destroy() {
      layer.remove();
      nodes.clear();
    },
  };
}
