// The site entry point — what index.qmd loads for every visit that does not ask
// for ?engine=old.
//
// One line of work: start the host on the hero stage, with the built-in rules
// expert driving the hat panda. The NN policy layer lives in the panda-engine
// repo (github.com/Ameya-bit/panda-engine) and is deliberately not shipped here;
// this file is maintained in THIS repo and excluded from tools/sync-site.sh.
// Kept as a real module (rather than an inline script) so every relative import
// inside the engine resolves against this file's URL, wherever the page itself
// happens to live.

import { mountPandas } from './host.js';
import { makeOverlay, truthProvider } from './overlay.js';

const stage = document.getElementById('panda-stage');
if (stage) {
  // `?overlay=truth` mounts the belief overlay on its ground-truth provider — the
  // dev stand-in for the eventual probe provider, and the way its look is judged
  // on the real page before there is a trained mind to read.
  const wantsOverlay = new URLSearchParams(location.search).get('overlay') === 'truth';
  const overlay = wantsOverlay ? makeOverlay(stage, truthProvider()) : null;

  // Exposed for the console: `__pandas.state` is the live sim, `__pandas.setPolicy()`
  // swaps the hat panda's brain, `__pandas.destroy()` takes the whole thing down.
  //
  // `entranceStyle: 'drop'` — the site's arrival (2026-08-03): the roamers rain
  // onto their spots and land into the ordinary knock; the hat panda still walks
  // on. Sim default stays 'walk' (the training corpora are frozen against it);
  // `?entrance=walk` restores the old walk-in for A/B against it.
  const wantsWalk = new URLSearchParams(location.search).get('entrance') === 'walk';
  // Three rects, not one: the editorial hero (2026-08-03) offsets headline, lede
  // and filing corner into a Z, and fencing each block separately is what keeps
  // the mid-left pocket between them walkable — a single .hero-inner bounding box
  // would swallow it, which is the whole point of the layout.
  const host = mountPandas(stage, {
    cardSelector: '.hero-headline, .hero-lede, .hero-filing',
    ...(wantsWalk ? {} : { config: { entranceStyle: 'drop' } }),
    ...(overlay ? { overlay } : {}),
  });
  window.__pandas = host;
}
