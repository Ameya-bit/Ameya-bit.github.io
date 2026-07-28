// The site entry point — what index.qmd loads for every visit that does not ask
// for ?engine=old.
//
// Two lines of work: start the host on the hero stage, and — only if the visitor
// asked for it with `?policy=nn` — fetch the trained clone and hand it the panda.
// Kept as a real module (rather than an inline script) so every relative import
// inside the engine resolves against this file's URL, wherever the page itself
// happens to live.

import { mountPandas } from './host.js';
import { fetchPolicy, wantedPolicy } from './policy-loader.js';

const stage = document.getElementById('panda-stage');
if (stage) {
  // Exposed for the console: `__pandas.state` is the live sim, `__pandas.setPolicy()`
  // swaps the hat panda's brain, `__pandas.destroy()` takes the whole thing down.
  const host = mountPandas(stage, { cardSelector: '.hero-inner' });
  window.__pandas = host;

  if (wantedPolicy() === 'nn') {
    // After the hero is already moving, never before it. A failure here is a
    // non-event by design: the rules expert is what was driving in the meantime, and
    // it simply keeps driving.
    fetchPolicy()
      .then((policy) => {
        host.setPolicy(policy);
        console.info('[pandas] the trained policy is driving — ?policy=rules switches back');
      })
      .catch((err) => console.warn('[pandas] could not load the policy; staying on the rules expert', err));
  }
}
