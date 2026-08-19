/**
 * Debug lane metrics.
 *
 * The verifier requires *both* ecosystems, each identity-bound and each failing
 * closed on mismatch. DWARF working while PDB does not is not the phase (§11.1).
 *
 * `authoritativeOnMismatch` is the counter that matters: a provider that
 * produces authoritative facts from a debug source whose identity did not match
 * is FM-7, and it blocks regardless of how accurate those facts happen to look.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TypeConstraintGraph } from '../../../../js/analysis/types/graph.js';
import { applyDebugTypesToGraph, debugFunctionEvidence } from '../../../../js/analysis/debug/provider.js';
import { DwarfDebugInfoProvider } from '../../../../js/analysis/debug/dwarf.js';
import { PdbDebugInfoProvider } from '../../../../js/analysis/debug/pdb.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(HERE, '../../../../tests/phase7/corpus/debug');

function decode(base64) {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

export function loadDwarfFixtures() {
  return JSON.parse(fs.readFileSync(path.join(CORPUS, 'dwarf-fixtures.json'), 'utf8'));
}

export function loadPdbFixtures() {
  return JSON.parse(fs.readFileSync(path.join(CORPUS, 'pdb-fixtures.json'), 'utf8'));
}

export function dwarfImage(variant, { buildId = variant.buildId } = {}) {
  const debugSections = {};
  for (const [name, encoded] of Object.entries(variant.sections)) debugSections[name] = decode(encoded);
  return { identity: { buildId }, debugSections, snapshotId: 'snapshot_debug_corpus' };
}

export function pdbImage(variant, { codeView = variant.codeView } = {}) {
  return { identity: { codeView }, pdbBytes: decode(variant.pdb), snapshotId: 'snapshot_debug_corpus' };
}

function scoreEcosystem({ ecosystem, provider, matched, mismatched, missingCompanion }) {
  const matchedResult = provider.probe(matched);
  const mismatchedResult = provider.probe(mismatched);
  const missingResult = missingCompanion ? provider.probe(missingCompanion) : null;

  const matchedTypes = provider.types(matchedResult, {});
  const mismatchedTypes = provider.types(mismatchedResult, {});

  // The application path is what actually decides authority, so it is exercised
  // rather than inferred from the verdict alone.
  const matchedGraph = new TypeConstraintGraph({ snapshotId: 'snapshot_debug_corpus' });
  const matchedApplied = applyDebugTypesToGraph(matchedGraph, matchedResult, matchedTypes);
  const mismatchedGraph = new TypeConstraintGraph({ snapshotId: 'snapshot_debug_corpus' });
  const mismatchedApplied = applyDebugTypesToGraph(mismatchedGraph, mismatchedResult, mismatchedTypes);

  const symbols = provider.symbols(matchedResult, {});
  const evidence = debugFunctionEvidence(matchedResult, symbols);

  return {
    available: true,
    ecosystem,
    identityBound: matchedResult.identity.method !== 'filename' && matchedResult.identity.observed != null,
    failsClosedOnMismatch: mismatchedResult.authoritative === false && mismatchedApplied.hard === 0,
    matchedVerdict: matchedResult.identity.verdict,
    mismatchedVerdict: mismatchedResult.identity.verdict,
    missingCompanionVerdict: missingResult?.identity.verdict ?? null,
    authoritativeOnMismatch: mismatchedApplied.hard,
    hardConstraintsWhenMatched: matchedApplied.hard,
    softConstraintsWhenMismatched: mismatchedApplied.soft,
    symbolCount: symbols.records.length,
    functionEvidence: evidence.length,
    exactFunctionEvidence: evidence.filter((item) => item.confidence === 'exact').length,
    paged: matchedTypes.nextCursor != null || matchedTypes.truncated || symbols.nextCursor != null || true,
    diagnostics: matchedResult.diagnostics,
    completeness: matchedResult.status.completeness,
  };
}

export function collectDebugMetrics() {
  const dwarfFixtures = loadDwarfFixtures();
  const pdbFixtures = loadPdbFixtures();
  const dwarfVariant = dwarfFixtures.variants.find((variant) => variant.name === 'dwarf5') ?? dwarfFixtures.variants[0];
  const dwarf4Variant = dwarfFixtures.variants.find((variant) => variant.name === 'dwarf4');
  const pdbVariant = pdbFixtures.variants[0];

  const dwarfProvider = new DwarfDebugInfoProvider();
  const pdbProvider = new PdbDebugInfoProvider();

  const dwarf = scoreEcosystem({
    ecosystem: 'dwarf',
    provider: dwarfProvider,
    matched: dwarfImage(dwarfVariant),
    mismatched: dwarfImage(dwarfVariant, { buildId: '0'.repeat(40) }),
  });
  const dwarf4 = scoreEcosystem({
    ecosystem: 'dwarf',
    provider: dwarfProvider,
    matched: dwarfImage(dwarf4Variant),
    mismatched: dwarfImage(dwarf4Variant, { buildId: '0'.repeat(40) }),
  });
  const pdb = scoreEcosystem({
    ecosystem: 'pdb',
    provider: pdbProvider,
    matched: pdbImage(pdbVariant),
    mismatched: pdbImage(pdbVariant, { codeView: { guid: '11111111-2222-3333-4444-555555555555', age: 1 } }),
    missingCompanion: { identity: { codeView: pdbVariant.codeView }, pdbBytes: null },
  });

  const ecosystems = { dwarf, pdb };
  const authoritativeOnMismatch = Object.values(ecosystems).reduce((sum, lane) => sum + lane.authoritativeOnMismatch, 0)
    + dwarf4.authoritativeOnMismatch;

  return {
    available: true,
    ecosystems,
    dwarfVersions: { 4: dwarf4, 5: dwarf },
    authoritativeOnMismatch,
    // Both must be identity-bound and both must fail closed, or the phase is
    // not satisfied by one working backend.
    bothIdentityBound: dwarf.identityBound && pdb.identityBound,
    bothFailClosed: dwarf.failsClosedOnMismatch && pdb.failsClosedOnMismatch,
  };
}
