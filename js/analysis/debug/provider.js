/**
 * P7-5 — the common DebugInfoProvider boundary.
 *
 * DWARF and PDB are very different formats, and the temptation is to let each
 * one apply its own facts its own way. That is exactly what this boundary
 * exists to prevent: both ecosystems produce the same result shapes, both go
 * through the same identity verdict, and neither has a private path into the
 * type graph or the symbol store (§11, FM-7).
 *
 * The load-bearing rule is identity. Debug information is evidence *about a
 * particular build*. Applying a plausible-but-wrong PDB or DWARF file produces
 * confident, detailed, false types — a far worse outcome than having no debug
 * information at all. So only a contract-approved identity match may create
 * authoritative facts, and every other state is surfaced diagnostically without
 * authority.
 *
 * Providers are paged. A large PDB or a heavily templated DWARF build can carry
 * hundreds of megabytes of records, and an iPad has to be able to open it.
 */

import { deepFreeze, stableDigest } from '../../core/identity/index.js';
import { createAnalysisStatus } from '../status.js';

export const DEBUG_PROVIDER_CONTRACT_VERSION = '1.0.0';
export const DEBUG_PROVIDER_SCHEMA_VERSION = 1;

/**
 * Identity verdicts. Only `matched-authoritative` and the covered parts of
 * `matched-partial` may produce hard constraints (§11.2).
 */
export const DEBUG_IDENTITY_VERDICTS = Object.freeze([
  'matched-authoritative',
  'matched-partial',
  'identity-unavailable',
  'identity-mismatch',
  'companion-missing',
  'unsupported',
]);

const AUTHORITATIVE_VERDICTS = new Set(['matched-authoritative', 'matched-partial']);

export const DEBUG_RECORD_KINDS = Object.freeze(['symbol', 'type', 'line', 'inline-frame', 'unwind']);

const VERDICT_SET = new Set(DEBUG_IDENTITY_VERDICTS);
const KIND_SET = new Set(DEBUG_RECORD_KINDS);

export const DEBUG_DEFAULT_PAGE_SIZE = 512;
export const DEBUG_DEFAULT_BUDGET = Object.freeze({
  maxBytesScanned: 64 * 1024 * 1024,
  maxRecords: 200000,
  maxDepth: 64,
});

function fail(code) { throw new TypeError(code); }

function nonEmpty(value, code) {
  const text = String(value ?? '').trim();
  if (!text) fail(code);
  return text;
}

function optionalSizeBytes(value) {
  if (value == null) return null;
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) fail('debug-record-invalid-size');
  return size;
}

/**
 * The identity verdict for one debug source.
 *
 * Both the expected and the observed identity are recorded even when they
 * match, because a later provider or build change has to be able to tell that
 * the previously matched pair no longer applies.
 */
export function createDebugIdentity(input = {}) {
  const verdict = nonEmpty(input.verdict, 'debug-identity-verdict-required');
  if (!VERDICT_SET.has(verdict)) fail('debug-identity-invalid-verdict');
  const identity = {
    verdict,
    providerId: nonEmpty(input.providerId, 'debug-identity-provider-required'),
    providerVersion: nonEmpty(input.providerVersion, 'debug-identity-provider-version-required'),
    expected: input.expected == null ? null : String(input.expected),
    observed: input.observed == null ? null : String(input.observed),
    method: nonEmpty(input.method ?? 'unavailable', 'debug-identity-method-required'),
    detail: input.detail == null ? null : String(input.detail),
    coverage: input.coverage == null ? null : Object.freeze({ ...input.coverage }),
  };
  // A match must actually have compared something. Filename or path equality is
  // explicitly not authority (§11.2), so a verdict of matched-* with no
  // observed identity is rejected rather than trusted.
  if (AUTHORITATIVE_VERDICTS.has(verdict) && (identity.observed == null || identity.expected == null)) {
    fail('debug-identity-match-requires-compared-identities');
  }
  if (verdict === 'matched-authoritative' && identity.expected !== identity.observed) {
    fail('debug-identity-authoritative-requires-equal-identities');
  }
  if (identity.method === 'filename') fail('debug-identity-filename-is-not-authority');
  identity.digest = stableDigest({
    verdict: identity.verdict,
    providerId: identity.providerId,
    providerVersion: identity.providerVersion,
    observed: identity.observed,
    expected: identity.expected,
  });
  return deepFreeze(identity);
}

/** True when this identity may create authoritative (hard) facts. */
export function isAuthoritative(identity) {
  return !!identity && AUTHORITATIVE_VERDICTS.has(identity.verdict);
}

/** One record from a provider, always carrying its debug-source provenance. */
export function createDebugRecord(input = {}) {
  const kind = nonEmpty(input.kind, 'debug-record-kind-required');
  if (!KIND_SET.has(kind)) fail('debug-record-invalid-kind');
  return deepFreeze({
    kind,
    entityId: nonEmpty(input.entityId, 'debug-record-entity-required'),
    name: input.name == null ? null : String(input.name),
    address: input.address == null ? null : String(input.address),
    sizeBytes: optionalSizeBytes(input.sizeBytes),
    descriptor: input.descriptor ?? null,
    // Provenance is not optional. A debug-derived fact that cannot say which
    // provider and which matched build produced it cannot be invalidated
    // correctly when either changes.
    providerId: nonEmpty(input.providerId, 'debug-record-provider-required'),
    providerVersion: nonEmpty(input.providerVersion, 'debug-record-provider-version-required'),
    buildIdentity: input.buildIdentity == null ? null : String(input.buildIdentity),
    evidenceIds: [...new Set((input.evidenceIds ?? []).map(String))].sort(),
  });
}

/** One page of records plus the cursor for the next page. */
export function createDebugPage(input = {}) {
  return deepFreeze({
    records: deepFreeze([...(input.records ?? [])]),
    nextCursor: input.nextCursor == null ? null : String(input.nextCursor),
    truncated: input.truncated === true,
  });
}

/**
 * The provider result.
 *
 * `identity` gates everything: `symbols`, `types` and friends may be populated
 * regardless, but `authoritative` is what decides whether those records may
 * become hard constraints.
 */
export function createDebugProviderResult(input = {}) {
  const identity = input.identity?.digest ? input.identity : createDebugIdentity(input.identity ?? {});
  const status = input.status?.schemaVersion ? input.status : createAnalysisStatus(input.status ?? {});
  return deepFreeze({
    schemaVersion: DEBUG_PROVIDER_SCHEMA_VERSION,
    contractVersion: DEBUG_PROVIDER_CONTRACT_VERSION,
    providerId: identity.providerId,
    providerVersion: identity.providerVersion,
    ecosystem: nonEmpty(input.ecosystem, 'debug-result-ecosystem-required'),
    identity,
    authoritative: isAuthoritative(identity),
    sections: deepFreeze([...(input.sections ?? [])].map(String).sort()),
    counts: deepFreeze({ ...(input.counts ?? {}) }),
    diagnostics: deepFreeze([...(input.diagnostics ?? [])].map(String)),
    status,
  });
}

/**
 * The abstract provider.
 *
 * Subclasses implement `#probe` and the paged readers. The base class owns the
 * identity gate so no backend can accidentally skip it: `authoritativeTypes`
 * and `authoritativeSymbols` are the only accessors the application layer uses,
 * and they return nothing at all when the identity did not match.
 */
export class DebugInfoProvider {
  constructor({ id, version, ecosystem }) {
    this.id = nonEmpty(id, 'debug-provider-id-required');
    this.version = nonEmpty(version, 'debug-provider-version-required');
    this.ecosystem = nonEmpty(ecosystem, 'debug-provider-ecosystem-required');
  }

  /** Must return a `createDebugProviderResult`. */
  probe() { fail('debug-provider-probe-not-implemented'); }

  symbols() { return createDebugPage({}); }
  types() { return createDebugPage({}); }
  lines() { return createDebugPage({}); }
  inlineFrames() { return createDebugPage({}); }

  /**
   * Records that may become authoritative facts.
   *
   * Non-matching identity yields an empty page — not the records with a lower
   * confidence attached. Surfacing them as "probably right" is precisely how a
   * wrong PDB ends up in someone's decompilation.
   */
  authoritativeRecords(result, reader, scope, options = {}) {
    if (!result.authoritative) return createDebugPage({ records: [], truncated: false });
    return reader.call(this, scope, options);
  }
}

/**
 * Applies debug records to the canonical TypeConstraintGraph.
 *
 * This is the *only* sanctioned path from a debug backend into type recovery.
 * Neither DWARF nor PDB may construct a type result of its own; both hand
 * constraints to the graph and let it decide (§11.1 step 6).
 */
export function applyDebugTypesToGraph(graph, result, page) {
  if (!graph) fail('debug-apply-graph-required');
  const applied = { hard: 0, soft: 0, skipped: 0 };
  for (const record of page.records ?? []) {
    if (record.kind !== 'type') { applied.skipped += 1; continue; }
    const claim = {
      layer: record.descriptor?.layer ?? 'nominal',
      entityId: record.entityId,
      descriptor: record.descriptor?.claim ?? record.descriptor,
    };
    if (result.authoritative) {
      graph.addHardConstraint({
        kind: 'debug-type',
        origin: 'debug-matched',
        claim,
        evidenceIds: record.evidenceIds,
        providerVersion: record.providerVersion,
        buildIdentity: record.buildIdentity,
      });
      applied.hard += 1;
      continue;
    }
    // Unmatched debug data is still information — it just has no authority. It
    // enters as soft evidence so a user can see it, and it can never overrule a
    // hard constraint or reach certainty on its own.
    graph.addSoftEvidence({
      kind: 'signature-candidate',
      origin: 'debug-unmatched',
      weight: 0.3,
      claim,
      evidenceIds: record.evidenceIds,
    });
    applied.soft += 1;
  }
  return applied;
}

/**
 * Turns debug symbol records into function-discovery evidence.
 *
 * Same rule: an unmatched provider contributes weak, clearly-labelled evidence
 * rather than authoritative starts.
 */
export function debugFunctionEvidence(result, page) {
  const authoritative = result.authoritative;
  return (page.records ?? [])
    .filter((record) => record.kind === 'symbol' && record.address != null && record.descriptor?.isFunction === true)
    .map((record) => ({
      kind: 'debug-symbol',
      address: record.address,
      sizeBytes: record.sizeBytes ?? null,
      name: record.name,
      confidence: authoritative ? 'exact' : 'heuristic',
      providerId: record.providerId,
      providerVersion: record.providerVersion,
      buildIdentity: record.buildIdentity,
      evidenceIds: record.evidenceIds,
    }));
}
