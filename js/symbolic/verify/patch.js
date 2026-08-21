/**
 * js/symbolic/verify/patch.js
 *
 * Patch Verification over original vs patched Semantic IR representations.
 * Proves bounded semantic preservation or identifies functional delta.
 */

import { verifyBoundedEquivalence } from './equivalence.js';
import { VERDICT, CLAIM_KIND } from './query.js';

export async function verifyPatchEquivalence({
  originalBinaryId = 'original_binary',
  patchedPatchSetId = 'patch_set_1',
  originalTarget = null,
  patchedTarget = null,
  originalIr = null,
  patchedIr = null,
  correspondence = {},
  preconditions = null,
  memoryRegions = [],
  backend = null,
  session = null,
  options = {},
} = {}) {
  if (!originalTarget || !patchedTarget) {
    throw new TypeError('verifyPatchEquivalence: originalTarget and patchedTarget are required');
  }

  const result = await verifyBoundedEquivalence({
    beforeIr: originalIr,
    afterIr: patchedIr,
    beforeTarget: originalTarget,
    afterTarget: patchedTarget,
    correspondence,
    preconditions,
    memoryRegions,
    backend,
    session,
    options: {
      ...options,
      proofScope: options.proofScope || {
        kind: 'patch-equivalence',
        originalBinaryId: String(originalBinaryId),
        patchedPatchSetId: String(patchedPatchSetId),
        memoryRegions,
      },
    },
  });

  return Object.freeze({
    originalBinaryId: String(originalBinaryId),
    patchedPatchSetId: String(patchedPatchSetId),
    ...result,
  });
}
