// The pipelined policy driver — the seam adapter for a net that lives in a worker.
//
// The synchronous driver (`policy/driver.js`) computes and applies in the same
// decision tick, which is what the trainer wants and what put p99 2 ms on the main
// thread. This one runs the same contract the page ships: at decision tick k it
//
//   1. applies the action sampled from the logits the worker computed for the frame
//      posted at decision k-1 (the pipelined delay — `delayPolicy(_, 1)` headless,
//      `--delay 1` in training), and
//   2. encodes the frame for decision k and posts it, to be applied at k+1.
//
// The observation encoder stays on the main thread (it reads the live state) and so
// does the sampler (it owns the episode PRNG, and sampling on this side keeps the
// action stream deterministic in decision order whenever the worker keeps up).
//
// Three failure shapes, three answers, all of them "the rules expert drives":
//   - a *miss* — the worker's answer for k-1 has not arrived by decision k. Not a
//     bug: a slow machine. Null for this tick; `maxMisses` consecutive misses
//     retires the policy for the visit, which is the progressive-enhancement floor
//     doing its job on hardware that cannot afford the net.
//   - a *bad pass* — NaN/Inf logits or a worker-side throw. Same `maxFailures`
//     accounting as the synchronous driver.
//   - a *dead worker* — `onerror`. Retire immediately.
//
// `makeWorkerPolicy` takes the worker as an argument (anything with postMessage /
// onmessage / terminate) so the pipeline is testable in Node with a fake; spawning
// the real one is `policy-loader.js`'s job.

import { mulberry32Next } from '../rng.js';
import { makeObserver } from '../policy/obs.js';
import { sample, DEFAULT_DRIVER } from '../policy/driver.js';

export const WORKER_DRIVER = Object.freeze({
  // Consecutive decisions the worker failed to answer in time before the driver
  // retires for the visit. 40 decisions = 4 seconds of the net never landing —
  // a machine that slow should simply keep the rules watcher.
  maxMisses: 40,
});

// How many answered sequence numbers to keep around. An answer is consumed one
// decision after it was posted; anything older is stale by definition.
const KEEP_RESULTS = 4;

/**
 * Build a `{ init(ctx) }` policy (the seam shape `mountPandas` takes) around a
 * worker that already accepted `init` and answered `ready`.
 *
 * @param {object} worker    postMessage / set onmessage / onerror / terminate
 * @param {object} manifest  the exported policy.json
 * @param {object} [options] DEFAULT_DRIVER + WORKER_DRIVER overrides, obsParams
 */
export function makeWorkerPolicy(worker, manifest, options = {}) {
  const opts = { ...DEFAULT_DRIVER, ...WORKER_DRIVER, ...options };
  const cfg = manifest.config;

  // One message handler for the life of the policy; `epoch` fences episodes so a
  // reply raced across a rebuild cannot leak into the new episode's pipeline.
  let epoch = 0;
  let results = new Map();
  let workerDead = false;

  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type !== 'logits' && msg.type !== 'error') return;
    if (msg.epoch !== epoch) return;
    results.set(msg.seq, msg.type === 'logits' ? msg.logits : { error: msg.message });
    for (const k of results.keys()) if (k < msg.seq - KEEP_RESULTS) results.delete(k);
  };
  worker.onerror = (err) => {
    workerDead = true;
    console.warn('[pandas] policy worker died; the rules expert is driving', err?.message ?? err);
  };

  return {
    manifest,
    describe: () => ({ ...cfg, temperature: opts.temperature, pipelined: true }),
    dispose() {
      workerDead = true;
      worker.terminate?.();
    },

    init(ctx = {}) {
      epoch += 1;
      results = new Map();
      worker.postMessage({ type: 'reset', epoch });

      const observer = options.observer ?? makeObserver(options.obsParams ?? {});
      if (observer.layout.tokens !== cfg.tokens) {
        throw new Error(`policy: net wants ${cfg.tokens} tokens, observer emits ${observer.layout.tokens}`);
      }
      const mem = observer.init();
      const probs = new Float32Array(cfg.n_actions);
      const myEpoch = epoch;

      let seq = 0;
      let rng = (ctx.seed ?? 0) | 0;
      let failures = 0;
      let misses = 0;
      let retired = false;
      const stats = { decisions: 0, fallbacks: 0, misses: 0, retired: false };

      const draw = () => {
        const next = mulberry32Next(rng);
        rng = next.state;
        return next.value;
      };
      const retire = () => {
        retired = true;
        stats.retired = true;
      };

      function act(state) {
        if (retired || workerDead) return null;
        stats.decisions += 1;

        // (1) The answer owed from the previous decision, if any and if on time.
        let action = null;
        if (seq > 0) {
          const owed = results.get(seq - 1);
          if (owed === undefined) {
            misses += 1;
            stats.misses += 1;
            stats.fallbacks += 1;
            if (misses >= opts.maxMisses) {
              retire();
              console.warn(`[pandas] policy worker missed ${misses} decisions in a row; ` +
                'the rules expert is driving for this visit');
            }
          } else {
            results.delete(seq - 1);
            misses = 0;
            action = owed.error ? null : sample(owed, probs, opts, draw);
            if (action === null) {
              failures += 1;
              stats.fallbacks += 1;
              if (failures >= opts.maxFailures) retire();
            } else {
              failures = 0;
            }
          }
        }

        // (2) This decision's frame, posted for the next one. postMessage clones
        // synchronously, so handing it the observer's reused buffer is safe.
        const frame = observer.observe(state, mem);
        worker.postMessage({ type: 'frame', epoch: myEpoch, seq, frame });
        seq += 1;

        return action;
      }
      act.stats = stats;
      return act;
    },
  };
}
