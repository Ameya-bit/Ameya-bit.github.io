// Bake the art data out of ../../pandas.js into render/art-data.js.
//
// The sprite paths, the hat pixel maps and their per-frame seats, and the five
// seated-rider cels are *data*, not logic: hand-authored in the workshops
// (design/sketches/*), exported, and pasted into pandas.js as literals. The
// renderer needs exactly the same bytes, so rather than retype them this script
// lifts the literals verbatim and writes them out as an ES module.
//
//   node tools/bake-art.js          # rewrite render/art-data.js
//   node tools/bake-art.js --check  # verify it still matches pandas.js (CI/test)
//
// Provenance rule: never hand-edit render/art-data.js. Author in the workshop,
// bake into pandas.js (see the hat pipeline), then re-run this.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, '..', '..', 'pandas.js');
const TARGET = join(here, '..', 'render', 'art-data.js');

// The literals to lift, in the order they are written out.
const WANTED = [
  { from: 'pandaSvg', to: 'PANDA_SVG', note: "ma5a's five sprite rows, run-length encoded (see DECODE_REF)" },
  { from: 'decodeRef', to: 'DECODE_REF', note: 'the encoding table PANDA_SVG is written in' },
  { from: 'HAT_PIXELS', to: 'HAT_PIXELS', note: 'the straw hat: 28x14 grid per facing, "x,y" -> colour' },
  { from: 'HAT_FIT_DEFAULT', to: 'HAT_FIT', note: 'per-facing, per-walk-frame seat for the worn hat' },
  { from: 'SIT_CELS', to: 'SIT_CELS', note: 'the seated rider: five hand-drawn 48x48 facings' },
];

// Scan a balanced `{...}` (or `[...]`) literal starting at `open`, skipping over
// string bodies so a brace inside a quoted path can never end the scan.
function readLiteral(src, open) {
  const pairs = { '{': '}', '[': ']' };
  const close = pairs[src[open]];
  let depth = 0;
  let quote = '';
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === src[open]) depth++;
    else if (c === close && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unterminated literal at ${open}`);
}

function lift(src, name) {
  const decl = new RegExp(`const\\s+${name}\\s*=\\s*`).exec(src);
  if (!decl) throw new Error(`could not find "const ${name} =" in pandas.js`);
  return readLiteral(src, decl.index + decl[0].length);
}

function build() {
  const src = readFileSync(SOURCE, 'utf8');
  const parts = WANTED.map(({ from, to, note }) => `// ${note}\nexport const ${to} = ${lift(src, from)};`);
  return `// GENERATED — do not edit by hand. Run \`node tools/bake-art.js\` to refresh.
//
// The hero pandas' art, lifted verbatim from ../../pandas.js: ma5a's walk/fall
// sprite rows (MIT), our straw hat, and the five hand-drawn seated-rider cels.
// The renderer builds SVG from these in render/art.js; the sim never sees them.

${parts.join('\n\n')}
`;
}

const baked = build();
if (process.argv.includes('--check')) {
  const have = readFileSync(TARGET, 'utf8');
  if (have !== baked) {
    console.error('render/art-data.js is stale — re-run: node tools/bake-art.js');
    process.exit(1);
  }
  console.log('art-data.js matches pandas.js');
} else {
  writeFileSync(TARGET, baked);
  console.log(`wrote ${TARGET} (${(baked.length / 1024).toFixed(1)} KB)`);
}
