// The shard format — how a recorded episode becomes bytes.
//
// B4 of design/panda-policy-net.md. `truth.js` emits `{ tick, action, obs, truth }`
// rows; this turns a stream of them into a file a trainer can `np.fromfile` and
// reshape in one line, and back again.
//
// ## One episode per shard, and why
//
// A shard is a **rectangle**: `rows × width` little-endian float32, no header, no
// padding, no framing. That is the whole format, and it is worth the discipline —
// `np.fromfile(path, '<f4').reshape(-1, width)` is the entire loader, in any
// language, with the manifest supplying `width`.
//
// It costs one constraint: the row width has to be constant, and it is not
// constant across a corpus, because the number of pandas is a per-episode draw
// (`corpus.js` varies density on purpose — it is the emergence lever). So the unit
// of a file is one episode. That is not a workaround so much as the natural grain:
// an episode is already the unit of determinism (a pure function of seed + config),
// so it is the unit that can be re-cut alone, verified alone, and — in B5 — written
// by its own worker with no coordination at all.
//
// ## Everything is float32, including the labels
//
// One dtype for the whole file, because two would mean two reads and an alignment
// rule. Integer labels are exact up to 2^24 (a tick index, a panda id, a timer —
// all far below it, and `assertFloat32Safe` pins that rather than trusting it).
// True positions are the one lossy field: they arrive as doubles and land with
// ~1e-4 px of error at stage scale. That is far under a pixel, labels are not
// simulated from, and anything needing the exact double can re-run the episode —
// determinism is what makes the trade cheap.

import { openSync, writeSync, closeSync, readFileSync, statSync } from 'node:fs';

import { OBS_WIDTH, DEFAULT_OBS } from '../assets/pandas/engine/policy/obs.js';
import { hashBytes, hex } from '../assets/pandas/engine/tools/checksum.js';
import { GLOBAL_FIELDS, ENTITY_FIELDS, SLOT_FIELDS } from './truth.js';

export const SHARD_VERSION = 1;

// Float32Array writes in platform byte order, so the format's "little-endian" is a
// claim about the machine as much as the code. Every platform this runs on is LE;
// a big-endian one would write a file that reads as garbage everywhere else, which
// is exactly the kind of silence worth refusing.
export const LITTLE_ENDIAN =
  new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

function assertLittleEndian() {
  if (!LITTLE_ENDIAN) {
    throw new Error('shard: this machine is big-endian; the shard format is little-endian float32');
  }
}

// ---- the row layout ----
//
// A row is a fixed sequence of blocks, each block `repeat` sub-rows of `width`
// floats. `repeat` is a number, or the string 'pandaCount' for the one block whose
// size the episode decides. The template goes in the manifest; `rowLayout` resolves
// it against a concrete panda count. One source, so a consumer's offsets and the
// writer's offsets cannot disagree.

export function rowTemplate({ slots = DEFAULT_OBS.slots, truth = true } = {}) {
  const blocks = [
    // The observation frame, exactly as the encoder built it: token 0 is the hat
    // panda, tokens 1..slots are the neighbour slots. Field names are in the
    // manifest's `observation.fields`, not repeated here.
    { name: 'obs', repeat: 1 + slots, width: OBS_WIDTH },
    // The 17-way action the engine actually applied — the behaviour-cloning target.
    { name: 'action', repeat: 1, width: 1, fields: ['action'] },
  ];
  if (truth) {
    blocks.push(
      { name: 'global', repeat: 1, width: GLOBAL_FIELDS.length, fields: [...GLOBAL_FIELDS] },
      { name: 'slots', repeat: slots, width: SLOT_FIELDS.length, fields: [...SLOT_FIELDS] },
      // Sub-row k is panda id k — the roster is dense and stable for an episode's
      // life, and `encodeRow` refuses a row where it is not.
      { name: 'entities', repeat: 'pandaCount', width: ENTITY_FIELDS.length, fields: [...ENTITY_FIELDS] },
    );
  }
  return { dtype: 'float32', endian: 'little', blocks };
}

// Resolve a template against one episode's panda count: adds each block's offset
// and concrete size, and the row width.
export function rowLayout({ slots = DEFAULT_OBS.slots, entities, truth = true } = {}) {
  if (!Number.isInteger(entities) || entities <= 0) {
    throw new Error(`rowLayout: entities must be a positive integer, got ${entities}`);
  }
  const template = rowTemplate({ slots, truth });
  let at = 0;
  const blocks = template.blocks.map((b) => {
    const repeat = b.repeat === 'pandaCount' ? entities : b.repeat;
    const size = repeat * b.width;
    const block = { ...b, repeat, at, size };
    at += size;
    return block;
  });
  return {
    version: SHARD_VERSION,
    dtype: template.dtype,
    endian: template.endian,
    slots,
    entities,
    truth,
    width: at,
    blocks,
    at: Object.fromEntries(blocks.map((b) => [b.name, b.at])),
  };
}

// ---- encoding one row ----

// Fill `out[at .. at+width)` from a recorder row. `deep` runs the expensive checks
// (every value present and finite); the writer does that on an episode's first row
// and keeps only the structural checks after — those are the ones that catch a
// changed roster mid-episode, and they are cheap.
export function encodeRow(row, layout, out, at = 0, { deep = false } = {}) {
  const obsBlock = layout.blocks[0];
  if (!row.obs || row.obs.length !== obsBlock.size) {
    throw new Error(
      `shard: row has ${row.obs ? row.obs.length : 'no'} observation floats, layout wants ${obsBlock.size} ` +
      '(a corpus is a recording of the sensor — record with an observer)',
    );
  }
  out.set(row.obs, at + obsBlock.at);
  out[at + layout.at.action] = row.action;

  if (layout.truth) {
    const t = row.truth;
    if (!t) throw new Error('shard: layout expects ground truth, row carries none');
    writeRecord(out, at + layout.at.global, t.global, GLOBAL_FIELDS);

    let p = at + layout.at.slots;
    if (t.slots.length !== layout.slots) {
      throw new Error(`shard: row has ${t.slots.length} slots, layout wants ${layout.slots}`);
    }
    for (const slot of t.slots) p = writeRecord(out, p, slot, SLOT_FIELDS);

    if (t.entities.length !== layout.entities) {
      // Not a corrupt row so much as a corrupt *assumption*: the roster is fixed at
      // init and nothing adds or removes a panda. If that ever changes, the shard
      // format changes with it.
      throw new Error(
        `shard: row has ${t.entities.length} pandas, layout wants ${layout.entities} — ` +
        'the roster changed mid-episode',
      );
    }
    p = at + layout.at.entities;
    for (let i = 0; i < t.entities.length; i++) {
      const e = t.entities[i];
      if (e.id !== i) {
        throw new Error(`shard: entity block ${i} holds panda ${e.id} — the roster is not in id order`);
      }
      p = writeRecord(out, p, e, ENTITY_FIELDS);
    }
  }

  if (deep) {
    for (let i = 0; i < layout.width; i++) {
      if (!Number.isFinite(out[at + i])) {
        throw new Error(`shard: column ${i} of the row is ${out[at + i]} (${describeColumn(layout, i)})`);
      }
    }
  }
  return at + layout.width;
}

function writeRecord(out, p, rec, fields) {
  for (let i = 0; i < fields.length; i++) out[p + i] = rec[fields[i]];
  return p + fields.length;
}

// Which block and field a flat column index falls in — for error messages and for
// anyone reading a shard by hand.
export function describeColumn(layout, col) {
  for (const b of layout.blocks) {
    if (col < b.at || col >= b.at + b.size) continue;
    const off = col - b.at;
    const sub = Math.floor(off / b.width);
    const name = b.fields ? b.fields[off % b.width] : `+${off % b.width}`;
    return b.repeat === 1 ? `${b.name}.${name}` : `${b.name}[${sub}].${name}`;
  }
  return `column ${col} (outside the row)`;
}

// A label is only worth storing as float32 if it survives the trip. Integers do,
// below 2^24; this is the assertion rather than the hope. Returns the largest
// integer magnitude seen, so a caller can watch the headroom.
export const FLOAT32_EXACT_INT = 1 << 24;

export function assertFloat32Safe(rec, fields, where) {
  let peak = 0;
  for (const f of fields) {
    const v = rec[f];
    if (!Number.isFinite(v)) throw new Error(`${where}.${f} is ${v}`);
    if (!Number.isInteger(v)) continue;
    if (Math.abs(v) >= FLOAT32_EXACT_INT) {
      throw new Error(`${where}.${f} = ${v} is past float32's exact integer range`);
    }
    peak = Math.max(peak, Math.abs(v));
  }
  return peak;
}

// ---- the writer ----

// Stream rows to a file. `chunkRows` rows are staged in one Float32Array and
// flushed together, so memory is bounded by the chunk and not by the episode.
// Close returns the shard's manifest entry.
export function makeShardWriter({ path, layout, chunkRows = 512 }) {
  assertLittleEndian();
  const chunk = new Float32Array(chunkRows * layout.width);
  const bytes = new Uint8Array(chunk.buffer);
  const fd = openSync(path, 'w');

  let held = 0; // rows staged in `chunk`
  let rows = 0; // rows written in total
  let digest; // FNV-1a over every byte, in order
  let closed = false;

  function flush() {
    if (held === 0) return;
    const used = held * layout.width * Float32Array.BYTES_PER_ELEMENT;
    const view = bytes.subarray(0, used);
    digest = digest === undefined ? hashBytes(view) : hashBytes(view, digest);
    writeSync(fd, view, 0, used);
    held = 0;
  }

  return {
    layout,
    get rows() { return rows; },

    write(row) {
      if (closed) throw new Error('shard: writer is closed');
      encodeRow(row, layout, chunk, held * layout.width, { deep: rows === 0 });
      held += 1;
      rows += 1;
      if (held === chunkRows) flush();
    },

    // Give up on this shard: close the descriptor without flushing what is staged.
    // The file is left partial and the caller is expected to remove it — an aborted
    // shard is not a short shard, it is not a shard.
    abort() {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },

    close() {
      if (closed) throw new Error('shard: writer is already closed');
      flush();
      closeSync(fd);
      closed = true;
      return {
        rows,
        width: layout.width,
        bytes: rows * layout.width * Float32Array.BYTES_PER_ELEMENT,
        // An empty shard hashes to the FNV offset basis, which is what hashBytes
        // of an empty view returns — spell it rather than leaving it undefined.
        digest: hex(digest === undefined ? hashBytes(new Uint8Array(0)) : digest),
      };
    },
  };
}

// ---- reading one back ----

// Load a whole shard. Small by design (one episode), so this reads it in full
// rather than streaming — the corpus loader that cares about memory is the Python
// one, and it will mmap.
export function readShard(path, layout) {
  assertLittleEndian();
  const buf = readFileSync(path);
  const stride = layout.width * Float32Array.BYTES_PER_ELEMENT;
  if (buf.byteLength % stride !== 0) {
    throw new Error(
      `shard ${path}: ${buf.byteLength} bytes is not a whole number of ${stride}-byte rows ` +
      '(wrong layout, or a truncated write)',
    );
  }
  // Node may hand back a Buffer that is a view into a larger pooled ArrayBuffer,
  // so slice by byteOffset rather than assuming the buffer starts at 0.
  const flat = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return {
    layout,
    rows: buf.byteLength / stride,
    bytes: buf.byteLength,
    digest: hex(hashBytes(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))),
    // The raw row, as a view — cheap, and what a numeric consumer wants.
    row(i) {
      return flat.subarray(i * layout.width, (i + 1) * layout.width);
    },
    // The row with its names back on. This is what the JSONL sample is made of, so
    // the sample is by construction a decode of the bytes rather than a second
    // rendering of the same data.
    decode(i) {
      return decodeRow(flat.subarray(i * layout.width, (i + 1) * layout.width), layout);
    },
  };
}

export function decodeRow(row, layout) {
  const out = {
    action: row[layout.at.action],
    obs: row.subarray(layout.at.obs, layout.at.obs + layout.blocks[0].size),
  };
  if (!layout.truth) return out;
  const readAt = (b, i) => readRecord(row, b.at + i * b.width, b.fields);
  const byName = Object.fromEntries(layout.blocks.map((b) => [b.name, b]));
  out.truth = {
    global: readAt(byName.global, 0),
    slots: Array.from({ length: layout.slots }, (_, i) => readAt(byName.slots, i)),
    entities: Array.from({ length: layout.entities }, (_, i) => readAt(byName.entities, i)),
  };
  return out;
}

function readRecord(row, at, fields) {
  const rec = {};
  for (let i = 0; i < fields.length; i++) rec[fields[i]] = row[at + i];
  return rec;
}

// The shard's size on disk, for a manifest check that does not re-hash gigabytes.
export const shardBytes = (path) => statSync(path).size;
