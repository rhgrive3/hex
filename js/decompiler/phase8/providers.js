/**
 * Language and compiler pattern providers.
 *
 * A provider is a refinement layer, not a second semantic engine. It looks at
 * facts the generic passes already proved — loop induction, aggregate
 * candidates, structured regions, recovered types — and offers an
 * interpretation: this is a string copy, that is an array of a known struct,
 * this loop should render as a `for`. It never sees an instruction, never
 * decodes anything, and never wins an argument with the generic evidence.
 *
 * Four guarantees are enforced here rather than documented and hoped for.
 *
 * **A provider cannot decode.** The view handed to a provider is constructed
 * field by field from published facts: ids, offsets, widths, strides, kinds,
 * certainties. There is no `insts`, no `text`, no register, no address. A
 * provider that wanted to read an instruction has nothing to read it from.
 *
 * **A provider cannot promote.** Every hint is recorded at the certainty the
 * *generic* evidence already supports. A hint about a region whose candidates
 * are all `candidate` is a `candidate` hint. Nothing a provider says moves a
 * fact up the ladder.
 *
 * **A provider cannot override a contradiction.** A hint that names a shape or a
 * type for a region carrying a hard conflict is recorded as `rejected`, with the
 * conflict that rejected it. It stays in the artifact — a rejected hint is
 * evidence about the provider, and deleting it would erase the disagreement.
 *
 * **A provider identifies itself.** Its id and version are part of the published
 * hint and of the pass registry digest, so changing a provider invalidates the
 * artifacts derived from it and nothing else.
 *
 * The generic passes do not import this file, and this file imports no target,
 * architecture or ABI module. That direction is the architecture boundary.
 */

import { createPassDescriptor, createPassResult } from './contract.js';

export const PROVIDER_PASS = createPassDescriptor({
  id: 'phase8.providers',
  version: '1.0.0',
  stage: 'providers',
  budgetClass: 'standard',
  consumes: ['cfg', 'ssa', 'induction', 'aggregates', 'structuredRegions'],
  preserves: ['cfg', 'dominators', 'loops', 'ssa', 'memorySsa', 'alias', 'effects', 'ranges', 'valueNumbers', 'deadCode', 'induction', 'aggregates', 'types', 'summaries', 'origins', 'structuredRegions'],
  invalidates: [],
  produces: ['providerHints'],
  description: 'Runs refinement providers over published generic facts and records their hints, including the ones the evidence rejected.',
});

/** The interface version. A change here invalidates every provider artifact. */
export const PROVIDER_INTERFACE_VERSION = 1;

export const PROVIDER_HINT_KINDS = Object.freeze([
  'idiom', 'nominal-type', 'render', 'rewrite-candidate', 'dispatch', 'state-machine',
]);

/** What became of a hint. `rejected` is published, never dropped. */
export const HINT_STATUSES = Object.freeze(['accepted', 'rejected']);

function fail(code) { throw new TypeError(code); }

function nonEmptyString(value, code) {
  if (typeof value !== 'string' || value.length === 0) fail(code);
  return value;
}

/**
 * Declares one provider.
 *
 * `refine` receives the fact view and returns hints. It is called with no
 * arguments beyond that view, so there is no channel through which it could
 * reach the IR even if it wanted to.
 */
export function createProvider(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('phase8-provider-invalid');
  const id = nonEmptyString(input.id, 'phase8-provider-id-required');
  const version = nonEmptyString(input.version, 'phase8-provider-version-required');
  if (typeof input.refine !== 'function') fail('phase8-provider-refine-required');
  const kinds = Object.freeze([...new Set(input.kinds ?? [])].sort());
  for (const kind of kinds) {
    if (!PROVIDER_HINT_KINDS.includes(kind)) fail(`phase8-provider-unknown-hint-kind:${kind}`);
  }
  if (kinds.length === 0) fail('phase8-provider-kinds-required');
  return Object.freeze({
    interfaceVersion: PROVIDER_INTERFACE_VERSION,
    id,
    version,
    kinds,
    description: input.description == null ? '' : String(input.description),
    refine: input.refine,
  });
}

/**
 * The only thing a provider ever sees.
 *
 * Built field by field on purpose. Passing the analysis state through — even
 * frozen — would hand every provider the IR, and "the provider does not decode
 * instructions" would become a promise rather than a property.
 */
export function providerView(analysis) {
  const induction = analysis?.get('induction') ?? null;
  const aggregates = analysis?.get('aggregates') ?? null;
  const structured = analysis?.get('structuredRegions') ?? null;
  const types = analysis?.get('types')?.recovered ?? null;

  const loops = (induction?.loops ?? []).map((loop) => Object.freeze({
    header: loop.header,
    classification: loop.classification,
    depth: loop.depth,
    parentHeader: loop.parentHeader,
    exitEdgeCount: loop.exitEdges.length,
    earlyExitCount: loop.earlyExitEdges.length,
    inductions: Object.freeze(loop.inductions.map((fact) => Object.freeze({
      valueId: fact.valueId,
      kind: fact.kind,
      bits: fact.bits,
      step: fact.step,
      signedness: fact.signedness,
      tripCount: fact.tripCount.exact,
      tripCompleteness: fact.tripCount.completeness,
      // Whether the loop has a guard this analysis could read, and whether its
      // bound is a proved constant. A `for` is renderable without an exact trip
      // count; it is not renderable without a guard.
      hasGuard: fact.guard != null,
      boundKnown: fact.bound?.constant != null,
      completeness: fact.completeness,
    }))),
  }));

  const regions = (aggregates?.regions ?? []).map((region) => Object.freeze({
    regionKey: region.regionKey,
    rootKind: region.rootKind,
    nominal: region.nominal,
    accessCount: region.accessCount,
    inductionStride: region.inductionStride,
    fields: Object.freeze(region.fields.map((field) => Object.freeze({
      offset: field.offset, widthBits: field.widthBits, reads: field.reads, writes: field.writes,
    }))),
    padding: Object.freeze(region.padding.map((entry) => Object.freeze({ from: entry.from, to: entry.to, bytes: entry.bytes }))),
    candidates: Object.freeze(region.candidates.map((entry) => Object.freeze({
      kind: entry.kind,
      certainty: entry.certainty,
      strideBytes: entry.strideBytes ?? null,
      elementWidthBits: entry.elementWidthBits ?? null,
    }))),
    conflicts: Object.freeze(region.conflicts.map((entry) => entry.kind)),
    // The ceiling any hint about this region may reach.
    highestCertainty: region.candidates.reduce((best, entry) => (
      ['candidate', 'supported', 'confirmed'].indexOf(entry.certainty) > ['candidate', 'supported', 'confirmed'].indexOf(best)
        ? entry.certainty : best
    ), 'candidate'),
  }));

  const constructs = structured?.edgesByConstruct ?? {};
  return Object.freeze({
    interfaceVersion: PROVIDER_INTERFACE_VERSION,
    loops: Object.freeze(loops),
    regions: Object.freeze(regions),
    control: Object.freeze({
      edgeCount: structured?.edgeCount ?? 0,
      residualGotoCount: structured?.residualGotoCount ?? 0,
      constraintEdgeCount: structured?.constraintEdgeCount ?? 0,
      constructs: Object.freeze({ ...constructs }),
      regionKinds: Object.freeze((structured?.regions ?? []).map((region) => region.kind)),
    }),
    // Names only. No layout, no addresses, no instruction anything.
    typeNames: Object.freeze([...new Set([...(types?.values?.values?.() ?? [])]
      .map((entry) => entry?.className ?? entry?.semanticType?.className ?? null)
      .filter((name) => name != null)
      .map((name) => String(name)))].sort()),
  });
}

const CERTAINTY_ORDER = Object.freeze(['candidate', 'supported', 'confirmed']);

/** Hard conflicts a provider hint may never argue with. */
const HARD_CONFLICTS = new Set(['nominal-disagreement', 'width-disagreement', 'boundary-crossing']);

/**
 * Judges one hint against the generic evidence.
 *
 * The provider proposes; this decides. A hint about a region with a hard
 * conflict is rejected outright; every other hint is capped at the certainty the
 * region's own evidence already reached.
 */
export function judgeHint(hint, view) {
  const region = hint.regionKey == null ? null : view.regions.find((entry) => entry.regionKey === hint.regionKey) ?? null;
  if (hint.regionKey != null && region == null) {
    return { status: 'rejected', certainty: 'candidate', reason: `no region ${hint.regionKey} in the published facts` };
  }
  const blocking = (region?.conflicts ?? []).filter((kind) => HARD_CONFLICTS.has(kind));
  if (blocking.length > 0) {
    return {
      status: 'rejected',
      certainty: 'candidate',
      reason: `the region carries an unresolved ${blocking.join(', ')}; a provider hint does not settle a contradiction`,
    };
  }
  const ceiling = region?.highestCertainty ?? 'candidate';
  const asked = CERTAINTY_ORDER.includes(hint.certainty) ? hint.certainty : 'candidate';
  const granted = CERTAINTY_ORDER.indexOf(asked) > CERTAINTY_ORDER.indexOf(ceiling) ? ceiling : asked;
  return {
    status: 'accepted',
    certainty: granted,
    reason: granted === asked ? null : `capped at ${granted}: the generic evidence for this region reaches no further`,
  };
}

/**
 * A `for` loop is worth suggesting when the generic facts already say the loop
 * is counted. This provider adds no analysis; it names a shape.
 */
export const COUNTED_LOOP_PROVIDER = createProvider({
  id: 'phase8.provider.counted-loop',
  version: '1.0.0',
  kinds: ['idiom', 'render'],
  description: 'Names a proved counted loop as a for-loop idiom.',
  refine(view) {
    const hints = [];
    for (const loop of view.loops) {
      if (loop.classification !== 'natural') continue;
      if (loop.earlyExitCount > 0) continue;
      const counted = loop.inductions.filter((fact) => fact.tripCount != null && fact.completeness === 'complete');
      if (counted.length === 1) {
        hints.push({
          kind: 'idiom',
          name: 'counted-loop',
          certainty: 'supported',
          targets: [`block:${loop.header}`, `value:${counted[0].valueId}`],
          evidence: [`the loop runs exactly ${counted[0].tripCount} times with step ${counted[0].step} and leaves by one edge`],
        });
      }
      // A `for` does not need an exact trip count. It needs an initialised
      // variable, a constant step and a guard — which is what makes this a
      // rendering hint and not a claim about how many times anything runs.
      const walkers = loop.inductions.filter((fact) => fact.step != null && fact.hasGuard);
      if (walkers.length >= 1) {
        hints.push({
          kind: 'render',
          name: 'for-loop',
          certainty: counted.length === 1 ? 'supported' : 'candidate',
          targets: [`block:${loop.header}`, `value:${walkers[0].valueId}`],
          evidence: [`the loop advances ${walkers[0].valueId} by ${walkers[0].step} under a guard this analysis could read, and leaves by one edge`],
        });
      }
    }
    return hints;
  },
});

/**
 * A pointer whose loop stride matches an array candidate's element width is a
 * traversal of that array. Again: no new analysis, only a name for what two
 * generic artifacts already agree on.
 */
export const ARRAY_TRAVERSAL_PROVIDER = createProvider({
  id: 'phase8.provider.array-traversal',
  version: '1.0.0',
  kinds: ['idiom'],
  description: 'Names a loop that walks an array candidate with a matching stride.',
  refine(view) {
    const hints = [];
    for (const region of view.regions) {
      if (region.inductionStride == null) continue;
      const array = region.candidates.find((entry) => entry.kind === 'array' && entry.strideBytes != null);
      if (array == null || array.strideBytes !== region.inductionStride) continue;
      hints.push({
        kind: 'idiom',
        name: 'array-traversal',
        regionKey: region.regionKey,
        // Asking for `confirmed` on purpose: the cap has to do its work.
        certainty: 'confirmed',
        targets: [`region:${region.regionKey}`],
        evidence: [`a loop advances this pointer by ${region.inductionStride} bytes, which is the element width of the array candidate`],
      });
    }
    return hints;
  },
});

/** Providers that ship. Order is by id, so the registry digest is stable. */
export const REGISTERED_PROVIDERS = Object.freeze(
  [ARRAY_TRAVERSAL_PROVIDER, COUNTED_LOOP_PROVIDER].sort((left, right) => left.id.localeCompare(right.id)),
);

function normalizeHint(raw, provider) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`phase8-provider-hint-invalid:${provider.id}`);
  const kind = nonEmptyString(raw.kind, `phase8-provider-hint-kind-required:${provider.id}`);
  if (!PROVIDER_HINT_KINDS.includes(kind)) fail(`phase8-provider-unknown-hint-kind:${provider.id}:${kind}`);
  if (!provider.kinds.includes(kind)) fail(`phase8-provider-undeclared-hint-kind:${provider.id}:${kind}`);
  const evidence = Array.isArray(raw.evidence) ? raw.evidence.map(String).filter((entry) => entry.length > 0) : [];
  // A hint with no evidence is an opinion, and an opinion cannot be audited.
  if (evidence.length === 0) fail(`phase8-provider-hint-evidence-required:${provider.id}`);
  const targets = Array.isArray(raw.targets) ? [...new Set(raw.targets.map(String))].sort() : [];
  if (targets.length === 0) fail(`phase8-provider-hint-targets-required:${provider.id}`);
  return {
    kind,
    name: nonEmptyString(raw.name, `phase8-provider-hint-name-required:${provider.id}`),
    regionKey: raw.regionKey == null ? null : String(raw.regionKey),
    certainty: raw.certainty == null ? 'candidate' : String(raw.certainty),
    targets,
    evidence,
  };
}

/** Runs the providers and publishes their hints, accepted and rejected alike. */
export function runProviderPass(context = {}, budget = {}, area = null) {
  if (area == null) throw new TypeError('phase8-providers-requires-staging-area');
  const analysis = context.analysis;
  const enabled = context.opts?.phase8Providers === false
    ? []
    : (context.providers ?? REGISTERED_PROVIDERS);
  const view = providerView(analysis);

  const abortedNow = () => {
    try { return typeof budget.shouldAbort === 'function' && budget.shouldAbort() === true; }
    catch { return true; }
  };

  const hints = [];
  const failures = [];
  let budgetExhausted = false;
  for (const provider of [...enabled].sort((left, right) => left.id.localeCompare(right.id))) {
    if (abortedNow()) { budgetExhausted = true; break; }
    let produced = [];
    try {
      produced = provider.refine(view) ?? [];
      if (!Array.isArray(produced)) fail(`phase8-provider-hints-not-an-array:${provider.id}`);
    } catch (error) {
      // A provider that throws is a provider that is switched off for this
      // function. It never takes the generic result down with it.
      failures.push({ providerId: provider.id, reason: String(error?.message ?? error) });
      continue;
    }
    for (const raw of produced) {
      let hint;
      try { hint = normalizeHint(raw, provider); }
      catch (error) { failures.push({ providerId: provider.id, reason: String(error?.message ?? error) }); continue; }
      const verdict = judgeHint(hint, view);
      hints.push(Object.freeze({
        providerId: provider.id,
        providerVersion: provider.version,
        interfaceVersion: provider.interfaceVersion,
        kind: hint.kind,
        name: hint.name,
        regionKey: hint.regionKey,
        targets: Object.freeze([...hint.targets]),
        evidence: Object.freeze([...hint.evidence]),
        requestedCertainty: hint.certainty,
        certainty: verdict.certainty,
        status: verdict.status,
        reason: verdict.reason,
      }));
    }
  }

  hints.sort((left, right) => (left.providerId.localeCompare(right.providerId))
    || left.kind.localeCompare(right.kind)
    || left.name.localeCompare(right.name)
    || left.targets.join().localeCompare(right.targets.join()));

  const facts = Object.freeze({
    contractVersion: PROVIDER_PASS.contractVersion,
    passVersion: PROVIDER_PASS.version,
    interfaceVersion: PROVIDER_INTERFACE_VERSION,
    providers: Object.freeze([...enabled].map((provider) => Object.freeze({
      id: provider.id, version: provider.version, kinds: provider.kinds,
    })).sort((left, right) => left.id.localeCompare(right.id))),
    hints: Object.freeze(hints),
    acceptedCount: hints.filter((hint) => hint.status === 'accepted').length,
    // Rejected hints are published. A provider whose hints keep being rejected
    // is information; deleting them would hide the disagreement.
    rejectedCount: hints.filter((hint) => hint.status === 'rejected').length,
    cappedCount: hints.filter((hint) => hint.status === 'accepted' && hint.certainty !== hint.requestedCertainty).length,
    failures: Object.freeze(failures),
    completeness: budgetExhausted || failures.length > 0 ? 'partial' : 'complete',
  });
  area.stage('providerHints', facts);

  const diagnostics = [];
  if (budgetExhausted) {
    diagnostics.push({
      severity: 'warning',
      code: 'phase8.providers.budget',
      message: 'Provider refinement stopped before every provider ran.',
      reason: 'The pass was cancelled; the hints published are a subset.',
    });
  }
  for (const failure of failures.slice(0, 4)) {
    diagnostics.push({
      severity: 'warning',
      code: 'phase8.providers.failed',
      message: `Provider ${failure.providerId} produced no usable hints.`,
      reason: failure.reason,
    });
  }
  if (facts.cappedCount > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'phase8.providers.capped',
      message: `${facts.cappedCount} hint(s) were capped at the certainty the generic evidence supports.`,
      reason: 'A provider cannot promote a fact past what the generic passes proved.',
    });
  }
  if (facts.rejectedCount > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'phase8.providers.rejected',
      message: `${facts.rejectedCount} hint(s) were rejected by the generic evidence.`,
      reason: [...new Set(hints.filter((hint) => hint.status === 'rejected').map((hint) => hint.reason))].slice(0, 3).join('; '),
    });
  }

  return createPassResult({
    descriptor: PROVIDER_PASS,
    status: 'changed',
    changed: true,
    completeness: facts.completeness,
    transforms: [],
    produced: ['providerHints'],
    diagnostics,
    invalidated: [],
  });
}

/**
 * The independent provider-authority check.
 *
 * Recomputes, from the published hints alone, whether any provider was allowed
 * more authority than the contract gives it: a hint above its region's ceiling,
 * an accepted hint over a hard conflict, or a hint with no evidence.
 */
export function providerAuthorityFailures(facts, view) {
  const failures = [];
  for (const hint of facts?.hints ?? []) {
    if (!HINT_STATUSES.includes(hint.status)) {
      failures.push({ providerId: hint.providerId, problem: 'unknown-status', detail: String(hint.status) });
    }
    if (hint.evidence.length === 0) {
      failures.push({ providerId: hint.providerId, problem: 'no-evidence', detail: hint.name });
    }
    if (hint.status !== 'accepted') continue;
    const region = hint.regionKey == null ? null : view?.regions?.find((entry) => entry.regionKey === hint.regionKey) ?? null;
    if (region == null) continue;
    if (region.conflicts.some((kind) => HARD_CONFLICTS.has(kind))) {
      failures.push({ providerId: hint.providerId, problem: 'accepted-over-hard-conflict', detail: `${hint.name} on ${hint.regionKey}` });
    }
    if (CERTAINTY_ORDER.indexOf(hint.certainty) > CERTAINTY_ORDER.indexOf(region.highestCertainty)) {
      failures.push({
        providerId: hint.providerId,
        problem: 'certainty-above-generic-evidence',
        detail: `${hint.name} reached ${hint.certainty} where the region reaches ${region.highestCertainty}`,
      });
    }
  }
  return failures;
}

/** A readable summary of what the providers said, for evidence. */
export function describeProviderHints(facts) {
  if (facts == null) return 'no provider hints';
  if (facts.hints.length === 0) return `${facts.providers.length} provider(s), no hint applied`;
  const names = [...new Set(facts.hints.map((hint) => `${hint.name}:${hint.status}`))].sort();
  return `${facts.hints.length} hint(s) from ${facts.providers.length} provider(s): ${names.join(', ')}`;
}
