import { expect, test } from 'vitest';
import { LEGAL_TARGETS as SERVER_LEGAL_TARGETS } from '../../src/lifecycle.js';
import { LEGAL_TARGETS as UI_LEGAL_TARGETS } from '../src/transitions.js';

/**
 * Lockstep guard: the UI's mirrored status machine must equal the daemon's
 * (src/lifecycle.ts is normative). The mirror exists because the bundle
 * cannot import daemon code; this test is what keeps the two honest —
 * change one side without the other and this fails.
 */

test('the UI status machine equals the daemon LEGAL_TARGETS', () => {
  expect(UI_LEGAL_TARGETS).toEqual(SERVER_LEGAL_TARGETS);
});
