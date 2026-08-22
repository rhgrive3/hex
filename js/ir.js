/* Public Semantic IR facade.
 *
 * Canonical Semantic IR v2 -> legacy-v1 compatibility projections are already
 * semantic IR. Re-running them through the legacy ARM64 decoder/lifter would
 * reinterpret x86-64/RISC-V facts as ARM64. Keep the historical implementation
 * in ir-public-base.js and short-circuit only the explicit canonical projection.
 */
export * from './ir-public-base.js';

import { irFor as baseIrFor } from './ir-public-base.js';

function isCanonicalV2CompatibilityProjection(model) {
  return model?.compat?.projection === 'semantic-ir-v2-to-v1'
    && typeof model?.semanticIrVersion === 'string'
    && Array.isArray(model?.instructions)
    && Array.isArray(model?.blocks)
    && typeof model?.defUse === 'function';
}

export function irFor(model, options) {
  if (isCanonicalV2CompatibilityProjection(model)) return model;
  return baseIrFor(model, options);
}
