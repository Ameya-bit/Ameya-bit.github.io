// Fetching the trained policy, in the browser, without making anyone wait for it.
//
// Phase D's kill switch is `?policy=`, and this is what the `nn` setting does. It
// lives under `render/` because it is a browser concern end to end — `fetch`, a URL,
// a worker, a decision about when to spend bandwidth — and because `policy/` is
// engine code the determinism lint holds to a stricter standard than any of that
// could meet.
//
// **Nothing here blocks the hero.** The pandas start on the rules expert the moment
// the module runs; the weights are ~240 KB and arrive when they arrive, at which
// point `setPolicy` swaps the brain mid-scene. A visitor on a slow connection sees
// the shipped character and then, quietly, a different one — which is strictly better
// than an empty stage, and is also the fallback if the fetch never lands at all.
//
// **The forward pass runs in a Web Worker by default.** In-page p99 was 2 ms on the
// main thread against a 1 ms budget; in a worker the budget is the decision period
// (100 ms), because the pipeline applies each answer one decision late by contract
// (see worker-driver.js) and the renderer interpolates right over it. The
// synchronous main-thread driver stays reachable behind `?policy=nn-main` — it is
// what the trainer runs, and a page that can A/B the two is a page where "the worker
// changed the behaviour" is a checkable claim rather than a suspicion.

import { loadPolicy, observerParamsFor } from '../policy/load.js';
import { makePolicyDriver } from '../policy/driver.js';
import { makeObserver } from '../policy/obs.js';
import { makeWorkerPolicy } from './worker-driver.js';

// Where `trainer/py/export.py` writes. Relative to this module, so it resolves the
// same whether the page is at the site root or nested.
const WEIGHTS = new URL('../policy/weights/', import.meta.url);

// How long the worker gets to load 240 KB of weights and say `ready` before the
// page falls back to the main-thread driver. Generous on purpose: this fires once,
// after first paint, and the rules expert is driving throughout.
const WORKER_READY_MS = 10000;

async function fetchExport() {
  const [manifestRes, blobRes] = await Promise.all([
    fetch(new URL('policy.json', WEIGHTS)),
    fetch(new URL('policy.bin', WEIGHTS)),
  ]);
  if (!manifestRes.ok) throw new Error(`policy.json: ${manifestRes.status} ${manifestRes.statusText}`);
  if (!blobRes.ok) throw new Error(`policy.bin: ${blobRes.status} ${blobRes.statusText}`);

  const manifest = await manifestRes.json();
  const blob = await blobRes.arrayBuffer();
  if (blob.byteLength !== manifest.bytes) {
    throw new Error(`policy.bin is ${blob.byteLength} bytes, manifest says ${manifest.bytes}`);
  }
  return { manifest, blob };
}

// The observer is built from the *policy's* recorded parameters, not the encoder's
// defaults. Phase D's clone was trained through an open mask (`coneDeg` 360) while
// the shipped default is the 120-degree cone Phase E needs; handing it the default
// would feed it a view it has never seen and there would be nothing to see in the
// logs about why it behaved oddly.
function observerFor(manifest) {
  return makeObserver(observerParamsFor(manifest));
}

/**
 * Fetch and build the hat panda's trained brain on the main thread — the
 * synchronous driver the trainer uses, kept for `?policy=nn-main` and as the
 * fallback when workers are unavailable.
 */
export async function fetchPolicy(opts = {}) {
  const { manifest, blob } = await fetchExport();
  const observer = observerFor(manifest);
  const { net, warnings } = loadPolicy(manifest, new Uint8Array(blob), { observer });
  for (const w of warnings) console.warn(`[pandas] ${w}`);
  return makePolicyDriver(net, { observer, ...opts });
}

/**
 * Fetch the export and stand the pipelined worker policy up: spawn, init, await
 * `ready`. Throws if workers are unavailable or the worker cannot load the net —
 * callers fall back to `fetchPolicy`.
 */
export async function fetchWorkerPolicy(opts = {}) {
  if (typeof Worker !== 'function') throw new Error('no Worker in this browser');
  const { manifest, blob } = await fetchExport();

  // Run the load checks on this side too: a layout mismatch should be one loud
  // load-time error here, not a worker-side throw surfacing as a generic failure.
  const observer = observerFor(manifest);
  const { warnings } = loadPolicy(manifest, new Uint8Array(blob), { observer });
  for (const w of warnings) console.warn(`[pandas] ${w}`);

  const worker = new Worker(new URL('./policy-worker.js', import.meta.url), { type: 'module' });
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`policy worker not ready after ${WORKER_READY_MS} ms`));
    }, WORKER_READY_MS);
    worker.onmessage = (e) => {
      clearTimeout(timer);
      if (e.data.type === 'ready') resolveReady();
      else reject(new Error(e.data.message ?? 'policy worker failed to initialise'));
    };
    worker.onerror = (err) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(err?.message ?? 'policy worker failed to start'));
    };
    // The blob transfers (it is not needed on this side again); the manifest clones.
    worker.postMessage({ type: 'init', manifest, blob }, [blob]);
  });

  return makeWorkerPolicy(worker, manifest, { observer, ...opts });
}

// Read the kill switch. `rules` (or absent) is the shipped rules watcher; `nn` is
// the trained clone in its worker; `nn-main` is the same clone on the main thread.
// Deliberately opt-in for now: Phase A's port was `?engine=new` until it passed the
// character gate, and the same discipline applies to a brain — the page wins over
// the number, always, and only Ameya can say whether the motion reads right.
export function wantedPolicy(search = location.search) {
  const value = new URLSearchParams(search).get('policy');
  return value === 'nn' || value === 'nn-main' ? value : 'rules';
}
