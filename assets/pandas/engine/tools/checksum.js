// Deterministic state checksums for golden traces.
//
// Phase A's acceptance bar: 32 seeds x 10k ticks, per-tick checksums
// byte-identical between the Node import and the browser bundle. That only works
// if "checksum" means the same bytes everywhere, so we hash the raw IEEE-754
// representation of each state number (via DataView) rather than a stringified
// form — float-to-string can differ in the last digit across engines, raw bytes
// cannot. The hash itself is FNV-1a with integer-only ops (xor + Math.imul), so
// it too is bit-identical across every JS engine.

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

// Scratch buffer reused across calls — the engine hashes every tick, so avoid
// allocating an 8-byte buffer each time.
const scratch = new DataView(new ArrayBuffer(8));

// FNV-1a over a flat list of numbers. Each number contributes its 8 canonical
// little-endian float64 bytes. `-0` is normalised to `0` (they differ in bytes
// but are equal values, and the sim treats them identically); a NaN in state is
// a bug the trace *should* surface, so it is hashed as-is.
export function hashNumbers(nums, seed = FNV_OFFSET) {
  let h = seed >>> 0;
  for (let i = 0; i < nums.length; i++) {
    const n = nums[i] === 0 ? 0 : nums[i];
    scratch.setFloat64(0, n, true);
    for (let b = 0; b < 8; b++) {
      h ^= scratch.getUint8(b);
      h = Math.imul(h, FNV_PRIME);
    }
  }
  return h >>> 0;
}

// Fold a sequence of uint32 tick-hashes into a single uint32 digest — the
// per-seed fingerprint of an entire rollout.
export function foldHashes(hashes) {
  let h = FNV_OFFSET;
  for (let i = 0; i < hashes.length; i++) {
    let x = hashes[i] >>> 0;
    for (let b = 0; b < 4; b++) {
      h ^= x & 0xff;
      h = Math.imul(h, FNV_PRIME);
      x >>>= 8;
    }
  }
  return h >>> 0;
}

// uint32 -> fixed 8-char hex, for stable golden-file text.
export const hex = (u) => (u >>> 0).toString(16).padStart(8, '0');
