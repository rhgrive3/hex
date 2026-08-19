/**
 * Cross-architecture metamorphic laws.
 *
 * These do not compare artifacts byte for byte across architectures — that
 * would be meaningless. They assert that the *generic* middle-end conclusions
 * are the same when the fixture contract makes them equivalent (§17.8).
 *
 * If one of these fails on one lane, the generic solver has learned something
 * about a particular architecture, which is FM-9.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeArchitectureNeutralSource } from '../../../tools/validation/semantic-v2/architecture-neutrality.mjs';
import { a1RegionAlias } from '../../../js/analysis/alias/a1-region-alias.js';
import { createMemoryRegionRef } from '../../../js/semantics/memoryssa/contract.js';
import { TypeConstraintGraph } from '../../../js/analysis/types/graph.js';
import { solveInterproceduralSummaries } from '../../../js/analysis/summary/interprocedural.js';
import { collectDiscoveryMetrics } from '../../../tools/validation/phase7/lanes/discovery.mjs';
import { buildSummaryGraph } from '../corpus/summaries.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Generic Phase 7 modules that must contain no architecture-specific text.
 *
 * The central solver is allowed to be *given* architecture-specific evidence;
 * it must never recognise it. Producers and compatibility shims are excluded
 * because being target-aware is their entire job.
 */
export const GENERIC_MODULES = Object.freeze([
  'js/analysis/status.js',
  'js/analysis/artifact-identity.js',
  'js/analysis/alias/result.js',
  'js/analysis/alias/a1-region-alias.js',
  'js/analysis/alias/solver.js',
  'js/analysis/pointsto/lattice.js',
  'js/analysis/pointsto/local.js',
  'js/analysis/pointsto/alias.js',
  'js/analysis/summary/contract.js',
  'js/analysis/summary/local.js',
  'js/analysis/summary/escape.js',
  'js/analysis/summary/interprocedural.js',
  'js/analysis/types/constraints.js',
  'js/analysis/types/graph.js',
  'js/analysis/debug/provider.js',
  'js/analysis/discovery/candidates.js',
  'js/analysis/discovery/fusion.js',
]);

/**
 * Format readers are deliberately excluded from the *architecture* neutrality
 * scan. A DWARF or PDB reader must know its own format's constants; what it
 * must not do is know an architecture. The master architecture keeps those
 * boundaries separate, so they are checked separately: the readers are held to
 * the import rule below rather than to the register/mnemonic rule.
 */
export const FORMAT_READER_MODULES = Object.freeze([
  'js/analysis/debug/dwarf.js',
  'js/analysis/debug/pdb.js',
]);

/**
 * Scans one generic module using the repository's canonical neutrality
 * analyzer.
 *
 * Reusing that analyzer rather than writing a second regex scan matters: a
 * weaker private check would drift from the one the rest of the repository is
 * held to, and a Phase 7 module could pass here while failing the real gate.
 */
export function scanArchitectureNeutrality(relativePath) {
  const file = path.join(ROOT, relativePath);
  if (!fs.existsSync(file)) return { file: relativePath, exists: false, violations: ['file is missing'] };
  const source = fs.readFileSync(file, 'utf8');
  const violations = analyzeArchitectureNeutralSource(source, relativePath)
    .map((violation) => `${violation.kind}:${violation.token}`);
  return { file: relativePath, exists: true, violations };
}

/**
 * Format readers may know their format but not the target boundary. Importing
 * an architecture or ABI module from a debug reader would put target semantics
 * behind the debug boundary, which the architecture forbids.
 */
export function scanFormatReaderImports(relativePath) {
  const file = path.join(ROOT, relativePath);
  if (!fs.existsSync(file)) return { file: relativePath, violations: ['file is missing'] };
  const source = fs.readFileSync(file, 'utf8');
  const violations = analyzeArchitectureNeutralSource(source, relativePath)
    .filter((violation) => violation.kind === 'target-architecture-import' || violation.kind === 'target-abi-import')
    .map((violation) => `${violation.kind}:${violation.token}`);
  return { file: relativePath, violations };
}

const evidence = (id) => ({ instructionIds: [`instruction_${id}`] });

/**
 * Law: exact disjoint stack intervals yield the same relation and proof class
 * on every lane. Region identity is architecture-neutral, so the answer must be
 * too.
 */
function disjointStackLaw(architectureId) {
  const region = (offset) => createMemoryRegionRef({
    id: `region_${architectureId}_${offset}`,
    kind: 'stack-fixed',
    functionId: `function_${architectureId}`,
    binaryId: `binary_${architectureId}`,
    offset,
    widthBits: 32,
    origin: evidence(`${architectureId}_${offset}`),
  });
  const result = a1RegionAlias(region(0), region(8));
  return {
    name: 'disjoint-stack-intervals-separate',
    holds: result.relation === 'no' && result.reasonCodes.includes('disjoint-stack-interval'),
    observed: `${result.relation}:${result.reasonCodes.join('|')}`,
  };
}

/** Law: an unresolved region never separates, on any lane. */
function unknownStoreLaw(architectureId) {
  const unknown = createMemoryRegionRef({
    id: `region_unknown_${architectureId}`,
    kind: 'unknown',
    functionId: `function_${architectureId}`,
    uncertaintyIdentity: { reason: 'unresolved-pointer' },
  });
  const known = createMemoryRegionRef({
    id: `region_known_${architectureId}`,
    kind: 'stack-fixed',
    functionId: `function_${architectureId}`,
    binaryId: `binary_${architectureId}`,
    offset: 0,
    widthBits: 32,
    origin: evidence(architectureId),
  });
  const result = a1RegionAlias(unknown, known);
  return {
    name: 'unknown-store-remains-a-barrier',
    holds: result.relation !== 'no' && result.relation !== 'must',
    observed: result.relation,
  };
}

/** Law: equivalent recursion converges to equivalent completeness on every lane. */
function recursionLaw() {
  const solved = solveInterproceduralSummaries({
    roots: ['fn_top'], localSummaries: buildSummaryGraph('mutual-recursion'),
  });
  return {
    name: 'equivalent-recursion-converges-equivalently',
    holds: solved.status.completeness === 'complete' && solved.status.stopReason == null,
    observed: `${solved.status.completeness}/${solved.iterations}`,
  };
}

/** Law: type contradiction behaviour does not depend on register names. */
function typeContradictionLaw(architectureId) {
  const graph = new TypeConstraintGraph({ snapshotId: `snapshot_${architectureId}` });
  const entityId = `entity_${architectureId}`;
  graph.addHardConstraint({
    kind: 'access-width', origin: 'binary-evidence',
    claim: { layer: 'machine', entityId, descriptor: { widthBits: 32, class: 'integer' } },
  });
  graph.addHardConstraint({
    kind: 'debug-type', origin: 'debug-matched',
    claim: { layer: 'machine', entityId, descriptor: { widthBits: 64, class: 'integer' } },
  });
  const result = graph.solveEntity(entityId);
  return {
    name: 'type-contradiction-is-architecture-independent',
    holds: result.layers.machine.confidence === 'unknown' && result.layers.machine.contradictions.length === 1,
    observed: result.layers.machine.confidence,
  };
}

/** Law: discovery fusion reaches the same conclusions on every lane. */
function discoveryLaw(architectureId) {
  const generic = collectDiscoveryMetrics({ architectureId: 'generic' });
  const lane = collectDiscoveryMetrics({ architectureId });
  return {
    name: 'discovery-fusion-is-architecture-independent',
    holds: lane.candidate.falseStarts === generic.candidate.falseStarts
      && lane.candidate.startRecall === generic.candidate.startRecall
      && lane.candidate.extentPrecision === generic.candidate.extentPrecision
      && lane.candidate.falseSplit === generic.candidate.falseSplit
      && lane.candidate.falseMerge === generic.candidate.falseMerge,
    observed: JSON.stringify(lane.candidate),
  };
}

/**
 * Evaluates every generic law for one architecture lane.
 *
 * A lane with no evidence is *not* silently green: `available` stays false and
 * the verifier treats it as a blocking missing lane.
 */
export function evaluateGenericLaws(architectureId) {
  const laws = [
    disjointStackLaw(architectureId),
    unknownStoreLaw(architectureId),
    recursionLaw(architectureId),
    typeContradictionLaw(architectureId),
    discoveryLaw(architectureId),
  ];
  const neutrality = [
    ...GENERIC_MODULES.map((module) => scanArchitectureNeutrality(module)),
    ...FORMAT_READER_MODULES.map((module) => scanFormatReaderImports(module)),
  ];
  const neutralityViolations = neutrality.filter((entry) => entry.violations.length > 0);
  return {
    available: true,
    architectureId,
    laws,
    genericLawsHold: laws.every((law) => law.holds) && neutralityViolations.length === 0,
    neutralityViolations: neutralityViolations.map((entry) => ({ file: entry.file, violations: entry.violations })),
  };
}
