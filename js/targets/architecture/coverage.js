import { validateMachineEffectBundle } from '../../semantics/effects/index.js';
import { architecturePluginV2 } from './registry.js';

export const MACHINE_EFFECTS_COVERAGE_SCHEMA = 'machine-effects-coverage/v1';

const EXACT_COMPLETENESS = new Set(['exact', 'exact-with-intrinsic']);
const COVERED_COMPLETENESS = new Set(['exact', 'exact-with-intrinsic', 'partial', 'unknown']);

function resolvePlugin(value) {
  if (value && typeof value === 'object' && typeof value.id === 'string') return value;
  return architecturePluginV2(value);
}

function frozenError(error) {
  return Object.freeze({
    name: String(error?.name || 'Error'),
    message: String(error?.message || error || 'unknown error'),
  });
}

export function machineEffectsCoverageDescriptor(architectureOrPlugin) {
  const plugin = resolvePlugin(architectureOrPlugin);
  if (!plugin) throw new TypeError('machine-effects-coverage-architecture-required');
  return Object.freeze({
    schemaVersion: MACHINE_EFFECTS_COVERAGE_SCHEMA,
    architectureId: String(plugin.id),
    semanticVersion: String(plugin.semanticVersion || '1'),
    modes: Object.freeze([...(typeof plugin.modes === 'function' ? plugin.modes() : [])]),
    capability: String(plugin.capabilities?.exactEffects || (typeof plugin.liftExact === 'function' ? 'available' : 'unsupported')),
    denominator: 'observed-decoded-instructions',
    unsupportedPolicy: 'explicit',
  });
}

export function classifyMachineEffectsCoverage(architectureOrPlugin, decoded, context = {}) {
  const plugin = resolvePlugin(architectureOrPlugin);
  if (!plugin) throw new TypeError('machine-effects-coverage-architecture-required');
  const base = {
    schemaVersion: MACHINE_EFFECTS_COVERAGE_SCHEMA,
    architectureId: String(plugin.id),
  };
  if (typeof plugin.liftExact !== 'function') {
    return Object.freeze({ ...base, status: 'unsupported', reason: 'machine-effects-lifter-unavailable' });
  }

  let bundle;
  try {
    bundle = plugin.liftExact(decoded, context);
  } catch (error) {
    return Object.freeze({ ...base, status: 'error', reason: 'machine-effects-lifter-error', error: frozenError(error) });
  }
  if (bundle == null) {
    return Object.freeze({ ...base, status: 'unsupported', reason: 'machine-effects-not-lifted' });
  }

  let validated;
  try {
    validated = validateMachineEffectBundle(bundle);
  } catch (error) {
    return Object.freeze({ ...base, status: 'error', reason: 'machine-effects-invalid-bundle', error: frozenError(error) });
  }
  if (!COVERED_COMPLETENESS.has(validated.completeness)) {
    return Object.freeze({
      ...base,
      status: 'error',
      reason: 'machine-effects-invalid-completeness',
      completeness: String(validated.completeness),
    });
  }
  return Object.freeze({
    ...base,
    status: 'covered',
    completeness: validated.completeness,
    exact: EXACT_COMPLETENESS.has(validated.completeness),
    instructionId: validated.instructionId,
  });
}

export function measureMachineEffectsCoverage(architectureOrPlugin, decodedInstructions, options = {}) {
  if (!Array.isArray(decodedInstructions)) throw new TypeError('machine-effects-coverage-instructions-array-required');
  const plugin = resolvePlugin(architectureOrPlugin);
  if (!plugin) throw new TypeError('machine-effects-coverage-architecture-required');
  const context = options.context && typeof options.context === 'object' ? options.context : {};
  const contextFor = typeof options.contextFor === 'function' ? options.contextFor : null;
  const classifications = decodedInstructions.map((decoded, index) => classifyMachineEffectsCoverage(
    plugin,
    decoded,
    contextFor ? (contextFor(decoded, index) ?? context) : context,
  ));
  const counts = {
    exact: 0,
    exactWithIntrinsic: 0,
    partial: 0,
    unknown: 0,
    unsupported: 0,
    error: 0,
  };
  for (const item of classifications) {
    if (item.status === 'unsupported') counts.unsupported += 1;
    else if (item.status === 'error') counts.error += 1;
    else if (item.completeness === 'exact') counts.exact += 1;
    else if (item.completeness === 'exact-with-intrinsic') counts.exactWithIntrinsic += 1;
    else if (item.completeness === 'partial') counts.partial += 1;
    else if (item.completeness === 'unknown') counts.unknown += 1;
  }
  const denominator = decodedInstructions.length;
  const exactCount = counts.exact + counts.exactWithIntrinsic;
  const coveredCount = exactCount + counts.partial + counts.unknown;
  return Object.freeze({
    ...machineEffectsCoverageDescriptor(plugin),
    denominatorCount: denominator,
    coveredCount,
    exactCount,
    unsupportedCount: counts.unsupported,
    errorCount: counts.error,
    coverageRate: denominator === 0 ? null : coveredCount / denominator,
    exactRate: denominator === 0 ? null : exactCount / denominator,
    counts: Object.freeze(counts),
    classifications: Object.freeze(classifications),
  });
}
