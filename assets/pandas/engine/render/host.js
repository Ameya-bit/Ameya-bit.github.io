// The host — everything the engine deliberately doesn't know about.
//
// The engine is a pure `step(state, action) -> state` with no clock and no DOM.
// Something has to own the parts that are genuinely of the browser: how often to
// call step, where the hero card is, how many pandas fit on this screen, when to
// stop because nobody is looking, and what a visit's seed is. That is this file.
//
// The loop is a fixed-timestep accumulator: real time goes in, whole 50 ms ticks
// come out, and the leftover fraction becomes the renderer's interpolation alpha.
// A slow frame is capped (never a spiral of death) rather than skipped, so the sim
// stays at exactly 20 Hz regardless of display refresh rate.

import { makeEngine } from '../engine.js';
import { TICK_MS, TICKS_PER_ACTION } from '../tick.js';
import { pandaCountForViewport } from '../layout.js';
import { makeRenderer } from './renderer.js';
import { makeFlourish } from './flourish.js';
import { buildTableau } from './tableau.js';

// Below this stage width the hero copy owns the space — a troupe this size would
// pile onto the headline, so the stage stays empty (pandas.js's MOBILE_MIN).
const MOBILE_MIN = 800;

// Fence padding: the hero card plus breathing room, and the body inset used to
// test whether a 100px wrapper is actually inside it (pandas.js's GAP / FOOT).
const FENCE_GAP = 12;

// A frame longer than this (a background tab waking, a long GC) is clamped rather
// than replayed — better a hitch than a burst of 200 ticks.
const MAX_FRAME_MS = 250;

// Recompute layout at most this often while a resize is in flight.
const RESIZE_DEBOUNCE_MS = 150;

// The fenced hero card in stage-local pixels, or null when there is no card.
function computeFence(stage, cardSelector) {
  const card = cardSelector ? document.querySelector(cardSelector) : null;
  if (!card) return null;
  const c = card.getBoundingClientRect();
  const s = stage.getBoundingClientRect();
  return {
    l: c.left - s.left - FENCE_GAP,
    t: c.top - s.top - FENCE_GAP,
    r: c.right - s.left + FENCE_GAP,
    b: c.bottom - s.top + FENCE_GAP,
  };
}

/**
 * Run the hero pandas inside `stage`.
 *
 * @param {HTMLElement} stage   the stage element (`#panda-stage`)
 * @param {object} [opts]
 * @param {string} [opts.cardSelector] the element to fence off ('.hero-inner')
 * @param {number} [opts.seed]         pin the seed (dev/preview); default per-visit
 * @param {boolean} [opts.reduced]     force the static tableau
 * @param {number} [opts.areaPerPanda] density override (dev slider)
 * @param {object} [opts.config]       extra engine config overrides
 * @param {object} [opts.policy]       a `{ init(ctx) }` brain for the hat panda
 *                                     (Phase D's `?policy=nn`); default is the
 *                                     built-in rules expert
 * @returns {{destroy: () => void, get state(): object}}
 */
export function mountPandas(stage, opts = {}) {
  // Marks this stage as engine-rendered, which is what lets render/pandas.css
  // outrank the old sheet's `.panda_wrapper { transition: transform 2s }`. That
  // rule ships alongside us for as long as ?engine=old does, and inheriting it
  // double-smooths every stride — see the header of pandas.css.
  stage.classList.add('panda_engine');

  const cardSelector = opts.cardSelector ?? '.hero-inner';
  const reduced =
    opts.reduced ?? matchMedia('(prefers-reduced-motion: reduce)').matches;

  let engine = null;
  let state = null;
  let prevState = null;
  let renderer = null;
  let flourish = null;
  let rafId = 0;
  let lastFrame = 0;
  let acc = 0;
  let onScreen = true;
  let destroyed = false;
  let resizeTimer = 0;

  // The hat panda's brain, when it is not the built-in rules expert. `policy` is the
  // factory; `act` is this world's bound instance, re-minted whenever the world is —
  // it holds an episode's slot memory and frame history, and a rebuild is a new
  // episode. Null for both means the engine's own expert drives, which is the
  // default and the fallback.
  let policy = opts.policy ?? null;
  let act = null;
  // The seed this world was built from. `state` carries the PRNG's *current* value,
  // not the one it started at, and a policy attaching mid-visit needs the latter to
  // seed its own stream reproducibly.
  let worldSeed = 0;

  // ---- world construction ----

  function buildConfig() {
    const width = Math.round(stage.clientWidth);
    const height = Math.round(stage.clientHeight);
    const forbid = computeFence(stage, cardSelector);
    const pandaCount = pandaCountForViewport(width, height, forbid, {
      ...(opts.areaPerPanda ? { areaPerPanda: opts.areaPerPanda } : {}),
    });
    return { width, height, forbid, pandaCount, reduced, ...(opts.config ?? {}) };
  }

  // The seed for this visit. Deliberately fresh each load (a returning visitor
  // shouldn't watch the same 20 minutes again) — the wall clock is legitimate
  // *here*, in the host, and never inside the sim: whatever seed lands is threaded
  // through state, so the run remains perfectly reproducible from it.
  const seedForVisit = () => (opts.seed ?? Date.now()) | 0;

  // Bind the policy to this world. Anything it throws (a weight file that does not
  // match this encoder, most likely) costs the page nothing: the rules expert is
  // still there, and it is what would have driven anyway.
  function bindPolicy(seed) {
    act = null;
    if (!policy) return;
    try {
      act = policy.init({ seed, cfg: engine.cfg });
    } catch (err) {
      console.warn('[pandas] policy failed to start; the rules expert is driving', err);
      policy = null;
    }
  }

  function build() {
    renderer?.clear();
    const config = buildConfig();
    if (config.width < MOBILE_MIN) {
      // Too narrow for a troupe: leave the stage empty rather than crowd the copy.
      engine = null;
      state = null;
      prevState = null;
      return false;
    }
    engine = makeEngine(config);
    worldSeed = seedForVisit();
    state = engine.init(worldSeed);
    if (config.reduced) state = buildTableau(state, engine.cfg);
    bindPolicy(worldSeed);
    prevState = state;
    renderer = renderer ?? makeRenderer(stage);
    flourish = flourish ?? makeFlourish(stage);
    acc = 0;
    return true;
  }

  // A resize keeps the world and re-frames it: new stage bounds and a new fence
  // land in a fresh config object (state is never mutated in place), so pandas
  // walk out of a shrunken area rather than being re-spawned mid-scene. Headcount
  // is deliberately NOT re-derived — adding or vanishing pandas mid-view reads as
  // a glitch, and a page load is a cheap way to get the new density.
  function reframe() {
    if (!state) {
      // Grown back past the floor: build the world it should have had all along.
      if (build()) syncPaused();
      return;
    }
    const { width, height, forbid } = buildConfig();
    if (width < MOBILE_MIN) {
      // Shrunk below it: hand the space back to the hero copy.
      stop();
      renderer.clear();
      flourish.destroy();
      state = null;
      prevState = null;
      return;
    }
    engine = makeEngine({ ...state.cfg, width, height, forbid });
    state = { ...state, cfg: engine.cfg };
    prevState = { ...prevState, cfg: engine.cfg };
  }

  // ---- the loop ----

  // Who decides this tick. Three claimants, in order:
  //
  //  1. **The flourish**, whenever it wants him — the hat-drop skit is authored
  //     character and outranks any brain, exactly as it outranks the rules expert.
  //  2. **The policy**, on decision ticks only (10 Hz), fed the state it is acting
  //     *from* — which is the pairing the corpora were recorded at (D0) and the one
  //     the trainer's `runEpisode` uses, so page and trainer ask the same question.
  //  3. **null**, which is the engine's own rules expert.
  //
  // The policy is consulted even while the skit owns him, and its answer thrown away.
  // That looks wasteful and is the cheap option: the frame ring has to stay a run of
  // *consecutive* decisions or the stacked-frame input silently means something else,
  // and a forward pass costs ~0.5 ms against a 100 ms decision period.
  function actionFor(current) {
    const scripted = flourish.action(current);
    const next = current.tick + 1;
    const chosen = act && next % TICKS_PER_ACTION === 0 ? safeAct(current, next) : null;
    return scripted ?? chosen;
  }

  // A policy that throws mid-visit is a bug, not an emergency: log it once, drop back
  // to the rules expert, and let the page carry on. `driver.js` already returns null
  // rather than throwing for the expected failures (NaN logits, an unusable
  // distribution) — this is for the unexpected ones.
  function safeAct(current, tick) {
    try {
      return act(current, tick);
    } catch (err) {
      console.warn('[pandas] policy threw; the rules expert is driving from here', err);
      act = null;
      policy = null;
      return null;
    }
  }

  function frame(now) {
    rafId = requestAnimationFrame(frame);
    const dt = Math.min(MAX_FRAME_MS, lastFrame ? now - lastFrame : 0);
    lastFrame = now;

    if (!state) return;
    acc += dt;
    while (acc >= TICK_MS) {
      prevState = state;
      state = engine.step(state, actionFor(state));
      acc -= TICK_MS;
    }
    renderer.sync(prevState, state, acc / TICK_MS, dt, flourish.sync(state, dt));
  }

  function start() {
    if (destroyed || rafId || !state) return;
    // The tableau is a still: draw it once and never schedule anything.
    if (state.cfg.reduced) {
      renderer.sync(state, state, 1, 0, flourish.sync(state, 0));
      return;
    }
    lastFrame = 0;
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    if (!rafId) return;
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  // Pause is simply "stop calling step". Nothing is torn down and state is a plain
  // snapshot, so resuming is free — the tick after the pause is the tick after the
  // one before it. A reduced-motion tableau renders once and then idles here too.
  function syncPaused() {
    if (document.hidden || !onScreen) stop();
    else start();
  }

  // ---- wiring ----

  const observer = new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    syncPaused();
  });
  observer.observe(stage);
  document.addEventListener('visibilitychange', syncPaused);

  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(reframe, RESIZE_DEBOUNCE_MS);
  };
  addEventListener('resize', onResize);

  if (build()) syncPaused();

  return {
    destroy() {
      destroyed = true;
      stop();
      clearTimeout(resizeTimer);
      observer.disconnect();
      document.removeEventListener('visibilitychange', syncPaused);
      removeEventListener('resize', onResize);
      renderer?.clear();
      flourish?.destroy();
    },
    get state() {
      return state;
    },
    get policy() {
      return policy;
    },
    // Attach (or clear, with null) the hat panda's brain. Separate from `mountPandas`
    // because the weights are fetched *after* first paint — the page must not wait on
    // 240 KB to start moving — so the policy arrives late and takes over mid-scene.
    // He is mid-stride when it lands and that is fine: the driver's first decision
    // primes its history from the frame it is handed, the same way an episode starts.
    setPolicy(next) {
      policy = next ?? null;
      if (state) bindPolicy(worldSeed);
    },
    rebuild() {
      stop();
      if (build()) syncPaused();
    },
  };
}
