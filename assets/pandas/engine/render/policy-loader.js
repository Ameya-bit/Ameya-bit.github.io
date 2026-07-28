// Fetching the trained policy, in the browser, without making anyone wait for it.
//
// Phase D's kill switch is `?policy=`, and this is what the `nn` setting does. It
// lives under `render/` because it is a browser concern end to end — `fetch`, a URL,
// a decision about when to spend bandwidth — and because `policy/` is engine code the
// determinism lint holds to a stricter standard than any of that could meet.
//
// **Nothing here blocks the hero.** The pandas start on the rules expert the moment
// the module runs; the weights are ~240 KB and arrive when they arrive, at which
// point `setPolicy` swaps the brain mid-scene. A visitor on a slow connection sees
// the shipped character and then, quietly, a different one — which is strictly better
// than an empty stage, and is also the fallback if the fetch never lands at all.

import { loadPolicy } from '../policy/load.js';
import { makePolicyDriver } from '../policy/driver.js';
import { makeObserver } from '../policy/obs.js';

// Where `trainer/py/export.py` writes. Relative to this module, so it resolves the
// same whether the page is at the site root or nested.
const WEIGHTS = new URL('../policy/weights/', import.meta.url);

/**
 * Fetch and build the hat panda's trained brain.
 *
 * @param {object} [opts]
 * @param {number} [opts.temperature]     family softmax temperature (see driver.js)
 * @param {number} [opts.dirTemperature]  direction softmax temperature
 * @returns {Promise<object>} a `{ init(ctx) }` policy for `mountPandas`
 */
export async function fetchPolicy(opts = {}) {
  const [manifestRes, blobRes] = await Promise.all([
    fetch(new URL('policy.json', WEIGHTS)),
    fetch(new URL('policy.bin', WEIGHTS)),
  ]);
  if (!manifestRes.ok) throw new Error(`policy.json: ${manifestRes.status} ${manifestRes.statusText}`);
  if (!blobRes.ok) throw new Error(`policy.bin: ${blobRes.status} ${blobRes.statusText}`);

  const manifest = await manifestRes.json();
  const bytes = new Uint8Array(await blobRes.arrayBuffer());
  if (bytes.byteLength !== manifest.bytes) {
    throw new Error(`policy.bin is ${bytes.byteLength} bytes, manifest says ${manifest.bytes}`);
  }

  // The observer is built from the *policy's* recorded parameters, not the encoder's
  // defaults. Phase D's clone was trained through an open mask (`coneDeg` 360) while
  // the shipped default is the 120-degree cone Phase E needs; handing it the default
  // would feed it a view it has never seen and there would be nothing to see in the
  // logs about why it behaved oddly.
  const observer = makeObserver(manifest.observation.params);
  const { net, warnings } = loadPolicy(manifest, bytes, { observer });
  for (const w of warnings) console.warn(`[pandas] ${w}`);

  return makePolicyDriver(net, { observer, ...opts });
}

// Read the kill switch. `rules` (or absent) is the shipped rules watcher; `nn` is the
// trained clone. Deliberately opt-in for now: Phase A's port was `?engine=new` until
// it passed the character gate, and the same discipline applies to a brain — the page
// wins over the number, always, and only Ameya can say whether the motion reads right.
export function wantedPolicy(search = location.search) {
  const value = new URLSearchParams(search).get('policy');
  return value === 'nn' ? 'nn' : 'rules';
}
