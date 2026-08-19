import assert from 'node:assert/strict';
import test from 'node:test';

import { collectPhase7Metrics } from '../../../tools/validation/phase7/metrics.mjs';

/**
 * Placeholder for P7-4 hard type constraint graph.
 *
 * It is not a skip. An unimplemented capability must be *visibly* absent and
 * must block the verifier, because "green by absence" is the failure mode the
 * process guardrails exist to stop. When the checkpoint lands, this file is
 * replaced by its real contract tests.
 */
test('the unimplemented lane reports absent and blocks the verifier', async () => {
  const metrics = await collectPhase7Metrics();
  const lane = metrics['types'];
  assert.ok(lane, 'the metrics collector must report the lane, even when it is empty');
  const absent = lane.available === false
    || Object.values(lane).some((value) => value && value.available === false);
  assert.ok(absent, 'this placeholder must be removed once the lane produces real evidence');
});
