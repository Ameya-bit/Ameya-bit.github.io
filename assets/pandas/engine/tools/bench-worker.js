// The E2 candidates' worker arm — a bench-only module worker.
//
// Deliberately NOT `render/policy-worker.js`: that file ships, and the
// candidates are pricing kernels with random weights. This worker exists so a
// candidate's round-trip is measured the way the pipeline would pay it — clone,
// queue, compute, reply — rather than projected from compute alone.

import { makeCandidates } from './bench-kernels.js';

let candidate = null;

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      candidate = makeCandidates().find((c) => c.name === m.name);
      if (!candidate) throw new Error(`unknown candidate: ${m.name}`);
      candidate.reset();
      self.postMessage({ type: 'ready', params: candidate.params });
    } else if (m.type === 'frame') {
      const logits = candidate.step(m.frame);
      self.postMessage({ type: 'logits', seq: m.seq, logits: logits.slice(0) });
    } else if (m.type === 'bench') {
      const times = new Array(m.iters);
      for (let i = 0; i < m.iters; i++) {
        const t0 = performance.now();
        candidate.step(m.frame);
        times[i] = performance.now() - t0;
      }
      self.postMessage({ type: 'benched', times });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
