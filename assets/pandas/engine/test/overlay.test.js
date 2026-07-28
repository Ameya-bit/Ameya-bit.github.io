// The belief overlay's providers — static facts only. How the chips *look* on the
// page is Ameya's call, judged on the real page; what a provider says about a
// state is a contract, and contracts get tests.

import test from 'node:test';
import assert from 'node:assert/strict';

import { truthProvider } from '../render/overlay.js';
import { MODE } from '../state.js';

// Providers read only what these tests hand them: entities with id/x/y/mode.
// That IS the contract — a provider reaching deeper should widen this fake first.
const stateOf = (...entities) => ({ cfg: {}, entities });
const e = (id, mode, x = 100, y = 200) => ({ id, mode, x, y });

test('the flagship pair: a sleeper and a knocked panda get different chips', () => {
  const read = truthProvider().init();
  const chips = read(stateOf(e(0, MODE.SLEEPER), e(1, MODE.KNOCKED)));
  assert.equal(chips.length, 2);
  const [sleeper, knocked] = chips;
  assert.equal(sleeper.label, 'sleeper');
  assert.equal(knocked.label, 'knocked');
  assert.notEqual(sleeper.tone, knocked.tone,
    'identical cels, different chips — that distinction is the whole project');
});

test('wanderers, the observing hat and entrances stay unlabelled', () => {
  const read = truthProvider().init();
  const chips = read(stateOf(e(0, MODE.WANDER), e(1, MODE.OBSERVING), e(2, MODE.ENTERING)));
  assert.deepEqual(chips, []);
});

test('the dangerous modes carry the danger tone', () => {
  const read = truthProvider().init();
  for (const mode of [MODE.ZOOMIES, MODE.TUMBLER]) {
    const [chip] = read(stateOf(e(0, mode)));
    assert.equal(chip.tone, 'danger');
  }
});

test('every chip carries the entity\'s id and drawn position', () => {
  const read = truthProvider().init();
  const [chip] = read(stateOf(e(7, MODE.SPINNER, 314, 159)));
  assert.equal(chip.id, 7);
  assert.equal(chip.x, 314);
  assert.equal(chip.y, 159);
  assert.equal(typeof chip.label, 'string');
  assert.ok(chip.label.length > 0);
});

test('every anomaly and set-piece mode yields a chip', () => {
  const read = truthProvider().init();
  const labelled = [
    MODE.KNOCKED, MODE.SLEEPER, MODE.TUMBLER, MODE.SPINNER, MODE.LOOP, MODE.STARER,
    MODE.ZOOMIES, MODE.MOONWALK, MODE.HICCUP, MODE.ROLLING, MODE.STACK_BASE,
    MODE.MOUNTING, MODE.RIDING,
  ];
  for (const mode of labelled) {
    const chips = read(stateOf(e(0, mode)));
    assert.equal(chips.length, 1, `mode ${mode} produced no chip`);
  }
});
