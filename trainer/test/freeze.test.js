// The roster freeze (Phase B's exit, change #5 of design/panda-policy-net.md).
//
// A cut corpus is bytes plus a manifest that says what they mean. Editing the
// anomaly roster, the mode vocabulary, the observation layout, the action space or
// a ground-truth column does not corrupt those bytes — it re-labels them, quietly,
// and every number downstream stays plausible. So the freeze is enforced here: each
// manifest committed under corpora/ is checked against the code as it stands, and
// the moment the two disagree this test goes red with the field that moved.
//
// Reads no shards (they are gitignored and gigabytes), so it runs in the ordinary
// unit suite.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { checkContract, describeDiff, encoderFingerprint, OBS_FIXTURE } from '../cut.js';
import { TRUTH_LABELS } from '../truth.js';
import { ANOMALY_KINDS } from '../../assets/pandas/engine/anomalies.js';
import { hex, hashBytes } from '../../assets/pandas/engine/tools/checksum.js';

const CORPORA = join(dirname(dirname(fileURLToPath(import.meta.url))), 'corpora');

const manifests = readdirSync(CORPORA)
  .filter((f) => f.endsWith('.manifest.json'))
  .map((f) => ({ file: f, manifest: JSON.parse(readFileSync(join(CORPORA, f), 'utf8')) }));

test('there is a corpus to be frozen against', () => {
  // Guards the guard: if corpora/ is ever empty this file would pass vacuously and
  // the roster would be unfrozen without anyone noticing.
  assert.ok(manifests.length > 0, 'no committed manifests under trainer/corpora');
});

for (const { file, manifest } of manifests) {
  test(`${file} still describes this engine, encoder and schemas`, () => {
    const diffs = checkContract(manifest);
    assert.deepEqual(
      diffs.map(describeDiff),
      [],
      `${manifest.name} was cut against different code. Either the change is wrong, or the ` +
        'corpus must be re-cut (node cut.js --spec ... --name ' + manifest.name + ') and any ' +
        'policy trained on it retrained.',
    );
  });
}

test('the roster is the 8 kinds the corpora were cut with', () => {
  // The engine's list, the truth vocabulary and the manifests all have to agree —
  // a ninth anomaly is the change this freeze exists to catch.
  assert.deepEqual([...ANOMALY_KINDS], [...TRUTH_LABELS.anomalyKind]);
  assert.equal(ANOMALY_KINDS.length, 8);
  for (const { manifest } of manifests) {
    if (manifest.truth) assert.deepEqual(manifest.truth.labels.anomalyKind, [...ANOMALY_KINDS]);
  }
});

test('the encoder fingerprint is the fixture, and is sensitive to one bit of it', () => {
  const { digest } = encoderFingerprint();
  assert.match(digest, /^[0-9a-f]{8}$/);
  assert.equal(digest, hex(hashBytes(readFileSync(OBS_FIXTURE))));
  // A sensor change that leaves the sim alone moves no golden digest — that is the
  // hole this fingerprint fills, so it has to actually track the file's content.
  const tampered = Buffer.from(readFileSync(OBS_FIXTURE));
  tampered[tampered.length - 2] ^= 0x01;
  assert.notEqual(digest, hex(hashBytes(tampered)));
});
