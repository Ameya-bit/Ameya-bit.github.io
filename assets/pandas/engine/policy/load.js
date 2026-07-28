// Getting the exported policy into a running net — one function, two callers.
//
// The browser fetches `policy.json` and `policy.bin` after first paint; the tests and
// the trainer read them off disk. Both end up here, so "what a policy is" is defined
// once: a manifest, a blob, and the compatibility check between them and the sensor
// they are about to be pointed at.

import { makeNet } from './net.js';
import { decodeFloat16 } from './net.js';
import { OBS_VERSION, OBS_WIDTH } from './obs.js';

// Build a net from the exported pair. `bytes` is a Uint8Array of policy.bin.
//
// The checks are the point of the function. A policy is a matrix multiplication
// against a specific observation layout: point it at a sensor whose columns mean
// something else and it does not fail, it just acts wrongly and plausibly — the same
// silence the corpus freeze exists to break, so it is broken the same way, loudly and
// at load time.
export function loadPolicy(manifest, bytes, { observer = null } = {}) {
  if (manifest.format !== 1) {
    throw new Error(`policy: unknown format ${manifest.format}`);
  }
  if (manifest.dtype !== 'float16') {
    throw new Error(`policy: unknown dtype ${manifest.dtype}`);
  }
  const cfg = manifest.config;
  if (cfg.obs_width !== OBS_WIDTH) {
    throw new Error(`policy: trained on ${cfg.obs_width}-wide tokens, this encoder emits ${OBS_WIDTH}`);
  }
  if (manifest.observation && manifest.observation.version !== OBS_VERSION) {
    throw new Error(
      `policy: trained against observation layout v${manifest.observation.version}, ` +
      `this engine emits v${OBS_VERSION}`,
    );
  }
  if (observer) {
    if (observer.layout.tokens !== cfg.tokens) {
      throw new Error(`policy: expects ${cfg.tokens} tokens, observer emits ${observer.layout.tokens}`);
    }
    // The sensor's own knobs are NOT frozen (Phase C tunes them per corpus), so a
    // mismatch here is legal — but it means the policy is looking through a different
    // eye than the one it learned with, which is worth saying out loud.
    const trained = manifest.observation?.params;
    if (trained) {
      const moved = Object.keys(trained).filter((k) => trained[k] !== observer.params[k]);
      if (moved.length) {
        return {
          net: makeNet(manifest, decodeFloat16(bytes)),
          warnings: [`sensor differs from training on ${moved.map((k) => `${k} ${trained[k]}->${observer.params[k]}`).join(', ')}`],
        };
      }
    }
  }
  return { net: makeNet(manifest, decodeFloat16(bytes)), warnings: [] };
}

// The sensor this policy was trained through, as `makeObserver` overrides. Phase D
// clones on the open mask (`coneDeg` 360) while Phase E's cone is the shipped
// default, so the page has to build the observer the *policy* expects rather than
// the encoder's default — otherwise it is fed a view it never saw in training.
export function observerParamsFor(manifest) {
  return { ...(manifest.observation?.params ?? {}) };
}
