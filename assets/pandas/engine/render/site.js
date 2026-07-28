// The site entry point — what index.qmd loads for every visit that does not ask
// for ?engine=old.
//
// Two lines of work: start the host on the hero stage, and — only if the visitor
// asked for it with `?policy=nn` — fetch the trained clone and hand it the panda.
// Kept as a real module (rather than an inline script) so every relative import
// inside the engine resolves against this file's URL, wherever the page itself
// happens to live.

import { mountPandas } from './host.js';
import { fetchPolicy, fetchWorkerPolicy, wantedPolicy } from './policy-loader.js';
import { makeOverlay, truthProvider } from './overlay.js';

const stage = document.getElementById('panda-stage');
if (stage) {
  // `?overlay=truth` mounts the belief overlay on its ground-truth provider — the
  // dev stand-in for the Phase-G probe provider, and the way its look is judged on
  // the real page before there is a trained mind to read.
  const wantsOverlay = new URLSearchParams(location.search).get('overlay') === 'truth';
  const overlay = wantsOverlay ? makeOverlay(stage, truthProvider()) : null;

  // Exposed for the console: `__pandas.state` is the live sim, `__pandas.setPolicy()`
  // swaps the hat panda's brain, `__pandas.destroy()` takes the whole thing down.
  const host = mountPandas(stage, { cardSelector: '.hero-inner', ...(overlay ? { overlay } : {}) });
  window.__pandas = host;

  const wanted = wantedPolicy();
  if (wanted !== 'rules') {
    // After the hero is already moving, never before it. A failure here is a
    // non-event by design: the rules expert is what was driving in the meantime, and
    // it simply keeps driving. `nn` runs the forward pass in a Web Worker (the
    // deployed path); `nn-main` keeps it on the main thread for A/B against it.
    const load = wanted === 'nn'
      ? fetchWorkerPolicy().catch((err) => {
          console.warn('[pandas] worker policy unavailable, trying the main thread', err);
          return fetchPolicy();
        })
      : fetchPolicy();
    load
      .then((policy) => {
        host.setPolicy(policy);
        console.info(`[pandas] the trained policy is driving (${wanted}) — ?policy=rules switches back`);
      })
      .catch((err) => console.warn('[pandas] could not load the policy; staying on the rules expert', err));
  }
}
