// The site entry point — what index.qmd loads when ?engine=new is on.
//
// One line of work: find the hero stage and start the host on it. Kept as a real
// module (rather than an inline script) so every relative import inside the engine
// resolves against this file's URL, wherever the page itself happens to live.

import { mountPandas } from './host.js';

const stage = document.getElementById('panda-stage');
if (stage) {
  // Exposed for the console and for future kill-switch work (`?policy=rules|nn`
  // in Phase D lands here): `__pandas.state` is the live sim, `__pandas.destroy()`
  // takes the whole thing down.
  window.__pandas = mountPandas(stage, { cardSelector: '.hero-inner' });
}
