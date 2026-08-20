/**
 * Aggregate, array and union candidates — with the ambiguity kept.
 *
 * The failure this pass is built against is a decompiler that looks at four
 * accesses, scores "struct" at 0.68 and "array" at 0.86, prints `int arr[4]`,
 * and throws the other answer away. The score was never a proof. What the
 * accesses actually established was that both shapes fit, and the reader needed
 * to know that.
 *
 * So nothing here picks. A region publishes every shape its evidence supports,
 * each with the facts behind it, and records the conflicts that stop any of them
 * being certain. Three rules make that stick:
 *
 * **Hard and soft evidence are different things.** A declared type or debug
 * record is hard. An access pattern is soft, however many times it repeats.
 * `confirmed` requires at least one hard fact and no conflict; a pile of soft
 * facts reaches `supported` and stops there. Frequency is not proof.
 *
 * **A conflict caps certainty, it does not get resolved.** Overlapping accesses,
 * two shapes that both fit, a pointer leaving the region, two declarations that
 * disagree — each is recorded and each holds every candidate in the region at
 * `candidate`. Forcing a source-like type through a contradiction is the merge
 * blocker this file exists to prevent.
 *
 * **No private type or alias truth.** Widths, offsets, strides and location
 * kinds are read from the Semantic IR; nominal names come from the recovered
 * types Phase 7 published. Where two accesses reach memory through pointers
 * loaded from the same slot, that is recorded as soft grouping evidence with the
 * reason — not as a proof that they touch the same object — and an unknown store
 * between them stops the grouping entirely.
 *
 * Nothing here reads instruction text.
 */

import { createPassDescriptor, createPassResult } from './contract.js';

export const AGGREGATE_PASS = createPassDescriptor({
  id: 'phase8.aggregates',
  version: '1.0.0',
  stage: 'high-level-recovery',
  budgetClass: 'standard',
  consumes: ['cfg', 'ssa', 'ranges', 'induction'],
  preserves: ['cfg', 'dominators', 'loops', 'ssa', 'memorySsa', 'alias', 'effects', 'ranges', 'valueNumbers', 'deadCode', 'induction', 'types', 'summaries', 'origins', 'structuredRegions', 'providerHints'],
  invalidates: [],
  produces: ['aggregates'],
  description: 'Publishes every aggregate shape a memory region supports, with hard/soft evidence separated and conflicts preserved.',
});

export const AGGREGATE_SUMMARY_VERSION = 1;

/** Shapes a region may be reported as. `unknown` is always available. */
export const AGGREGATE_KINDS = Object.freeze([
  'struct', 'array', 'array-of-struct', 'struct-of-array', 'union', 'embedded-object', 'object', 'unknown',
]);

/** Certainty ladder. Nothing climbs it on soft evidence alone. */
export const CERTAINTIES = Object.freeze(['candidate', 'supported', 'confirmed']);

const DEFAULT_LIMITS = Object.freeze({ maxAccesses: 4096, maxRegions: 256, maxCopyChain: 8 });

function originIdsOf(node) {
  const ids = node?.origin?.instructionIds;
  return Array.isArray(ids) ? ids : [];
}

function toBigInt(value) {
  if (value == null) return null;
  try { return BigInt(value); } catch { return null; }
}

/** Follows same-width copies so a base and a copy of it are one base. */
function unwrapCopies(value, limits) {
  let current = value;
  for (let step = 0; step < limits.maxCopyChain; step += 1) {
    const definition = current?.def;
    if (definition?.op !== 'mov' || definition.sub != null) break;
    const source = definition.args?.[0]?.value ?? null;
    if (source == null || source.bits !== current.bits) break;
    current = source;
  }
  return current;
}

/**
 * The identity of the memory region an access belongs to.
 *
 * A stack or global access identifies itself. Everything else is identified by
 * the pointer it came through — and when that pointer was itself loaded from a
 * location, by *that* location, so `p->a` and `p->b` reached through two reloads
 * of the same slot land in one region.
 *
 * That last step is a grouping *hypothesis*, not an alias proof, and it is
 * returned with the tier that says so. An unknown store between the two loads
 * withdraws it.
 */
export function regionIdentityOf(instruction, limits = DEFAULT_LIMITS) {
  const kind = instruction?.loc?.kind ?? null;
  if (kind === 'stack') {
    return { regionKey: 'stack-frame', rootKind: 'stack-frame', tier: 'hard', detail: 'the access names the stack frame directly' };
  }
  if (kind === 'global') {
    const address = instruction.loc?.address ?? instruction.loc?.key ?? 'unknown';
    return { regionKey: `global:${address}`, rootKind: 'global', tier: 'hard', detail: 'the access names a global address directly' };
  }
  const base = unwrapCopies(instruction?.addr?.base ?? null, limits);
  if (base == null) return null;
  const definition = base.def ?? null;
  if (definition?.op === 'load') {
    if (definition.unknownAliasBarrier != null) {
      // The slot the pointer came from may have been written by something this
      // analysis cannot see, so two reloads of it are not known to be the same
      // pointer. Fall back to the value itself.
      return {
        regionKey: `value:${base.id}`,
        rootKind: 'ssa-value',
        tier: 'hard',
        detail: 'an unknown store lies between the pointer load and this access, so reloads are not grouped',
      };
    }
    const key = definition.loc?.key ?? null;
    if (key != null) {
      return {
        regionKey: `via:${key}`,
        rootKind: 'pointer-from-slot',
        tier: 'soft',
        detail: `the pointer was loaded from ${key}; accesses through reloads of that slot are grouped on the hypothesis that it was not rewritten between them`,
      };
    }
  }
  return { regionKey: `value:${base.id}`, rootKind: 'ssa-value', tier: 'hard', detail: 'the access is through this pointer value' };
}

function accessOf(instruction, limits) {
  const widthBits = Number(instruction?.extra?.memoryAccess?.widthBits
    ?? (instruction?.loc?.size != null ? Number(instruction.loc.size) * 8 : 0)) || 0;
  const offset = toBigInt(instruction?.loc?.disp ?? instruction?.addr?.disp ?? null);
  const index = instruction?.addr?.index ?? null;
  const scaleShift = Number(instruction?.addr?.scale ?? 0);
  return {
    instructionId: instruction.id ?? null,
    // The value a load produced, carried here rather than looked up later: an
    // instruction without an id is invisible to a lookup, and a fact that
    // silently disappears is worse than one that is absent.
    producedValueId: instruction.dst?.id ?? null,
    op: instruction.op,
    offset,
    widthBits,
    byteWidth: widthBits > 0 ? widthBits / 8 : 0,
    indexed: index != null,
    indexValueId: index?.id ?? null,
    // A shift of n means the index is scaled by 2^n. A shift of 0 with an index
    // present means a byte stride, which is a real stride, not a missing one.
    strideBytes: index == null ? null : BigInt(1) << BigInt(scaleShift),
    base: unwrapCopies(instruction?.addr?.base ?? null, limits),
    origin: originIdsOf(instruction),
  };
}

/** Certainty from evidence. The only place the ladder is climbed. */
export function certaintyOf(support, conflicts) {
  if (conflicts.length > 0) return 'candidate';
  const hard = support.filter((fact) => fact.tier === 'hard');
  if (hard.length > 0) return 'confirmed';
  // Two independent soft observations are worth reporting as supported. No
  // number of them is worth calling confirmed: repetition is not proof.
  return support.length >= 2 ? 'supported' : 'candidate';
}

function candidate(kind, support, conflicts, extra = {}) {
  return Object.freeze({
    kind,
    certainty: certaintyOf(support, conflicts),
    support: Object.freeze(support.map((fact) => Object.freeze({ ...fact }))),
    conflicts: Object.freeze([...conflicts]),
    ...extra,
  });
}

function overlaps(left, right) {
  if (left.offset == null || right.offset == null) return false;
  const leftEnd = left.offset + BigInt(Math.max(0, left.byteWidth));
  const rightEnd = right.offset + BigInt(Math.max(0, right.byteWidth));
  return left.offset < rightEnd && right.offset < leftEnd;
}

/**
 * Derives every shape one region's accesses support.
 *
 * Exported so each rule can be exercised on its own: a rule that can only be
 * reached through a whole pass run is a rule nobody tests properly.
 */
export function candidatesFor(region) {
  const conflicts = [...region.conflicts];
  const candidates = [];
  const fixed = region.fields;
  const indexed = region.accesses.filter((access) => access.indexed);

  // Overlap: two accesses covering the same bytes with different widths are a
  // union as much as they are a struct. Both are published and the overlap keeps
  // either from being certain.
  const overlapping = [];
  for (let left = 0; left < fixed.length; left += 1) {
    for (let right = left + 1; right < fixed.length; right += 1) {
      if (overlaps(fixed[left], fixed[right])) overlapping.push([fixed[left], fixed[right]]);
    }
  }
  // Two widths at one offset never show up as two overlapping fields, because
  // one offset is one field observation. It is the same question all the same:
  // the bytes are being read two ways.
  const widthDisagreements = region.conflicts.filter((entry) => entry.kind === 'width-disagreement');
  if (overlapping.length > 0 || widthDisagreements.length > 0) {
    if (overlapping.length > 0) {
      conflicts.push({
        kind: 'overlapping-accesses',
        detail: `${overlapping.length} pair(s) of accesses cover the same bytes with different widths`,
        between: overlapping.slice(0, 4).map(([left, right]) => `+${left.offset}/${left.widthBits}b vs +${right.offset}/${right.widthBits}b`),
      });
    }
    candidates.push(candidate('union', [
      { tier: 'soft', fact: 'overlapping-accesses', detail: 'the same bytes are read or written at more than one width' },
    ], conflicts.map((entry) => entry.kind), {
      members: Object.freeze([
        ...overlapping.slice(0, 8).map(([left, right]) => Object.freeze({
          offset: left.offset, widths: Object.freeze([left.widthBits, right.widthBits]),
        })),
        ...widthDisagreements.slice(0, 8).map((entry) => Object.freeze({
          offset: null, widths: Object.freeze([...(entry.between ?? [])]),
        })),
      ]),
    }));
  }

  // Struct: two or more distinct fixed offsets. Padding is reported as padding,
  // never invented as a field.
  const distinctOffsets = [...new Set(fixed.map((field) => String(field.offset)))];
  if (distinctOffsets.length >= 2) {
    const support = [{ tier: 'soft', fact: 'fixed-offsets', detail: `${distinctOffsets.length} distinct fixed offsets are accessed from this base` }];
    if (overlapping.length === 0 && widthDisagreements.length === 0) {
      support.push({ tier: 'soft', fact: 'non-overlapping', detail: 'no two accesses cover the same bytes' });
    }
    if (region.nominal != null) {
      support.push({ tier: region.nominalTier, fact: 'nominal-type', detail: `the recovered types name this pointer ${region.nominal}` });
    }
    candidates.push(candidate('struct', support, conflicts.map((entry) => entry.kind), {
      fields: Object.freeze(region.fields.map((field) => Object.freeze({
        offset: field.offset, widthBits: field.widthBits, reads: field.reads, writes: field.writes,
        origin: Object.freeze({ instructionIds: Object.freeze(field.origin) }),
      }))),
      padding: Object.freeze(region.padding),
    }));
  }

  // Array by index: an indexed access whose scale matches the element width.
  const consistentIndexed = indexed.filter((access) => access.byteWidth > 0 && access.strideBytes === BigInt(access.byteWidth));
  if (consistentIndexed.length >= 1) {
    candidates.push(candidate('array', [
      { tier: 'soft', fact: 'indexed-access', detail: `${consistentIndexed.length} indexed access(es) scale the index by the element width` },
      ...(region.inductionStride != null
        ? [{ tier: 'soft', fact: 'induction-stride', detail: `a loop induction variable advances this pointer by ${region.inductionStride} bytes` }]
        : []),
    ], conflicts.map((entry) => entry.kind), {
      elementWidthBits: consistentIndexed[0].widthBits,
      strideBytes: consistentIndexed[0].strideBytes,
    }));
  }

  // Array by moving base: the pointer itself advances by exactly the width
  // being accessed, every iteration. That is a walk over consecutive elements,
  // and the stride comes from the P8-4 induction artifact rather than from a
  // second look at the loop.
  if (region.inductionStride != null && fixed.length > 0
      && new Set(fixed.map((field) => String(field.offset))).size === 1
      && fixed.every((field) => field.byteWidth > 0 && BigInt(field.byteWidth) === region.inductionStride)) {
    candidates.push(candidate('array', [
      { tier: 'soft', fact: 'induction-stride', detail: `a loop advances this pointer by ${region.inductionStride} bytes each iteration` },
      { tier: 'soft', fact: 'width-matches-stride', detail: `every access through it is ${fixed[0].widthBits} bits wide, which is exactly that stride` },
    ], conflicts.map((entry) => entry.kind), {
      elementWidthBits: fixed[0].widthBits,
      strideBytes: region.inductionStride,
    }));
  }

  // Array by stride: fixed offsets at a uniform spacing with one width. This is
  // exactly as good a fit as the struct above, so both stand and the ambiguity
  // is recorded rather than scored away.
  if (distinctOffsets.length >= 2 && overlapping.length === 0) {
    const sorted = [...new Set(fixed.map((field) => field.offset))].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const gaps = sorted.slice(1).map((offset, index) => offset - sorted[index]);
    const uniform = gaps.length > 0 && gaps.every((gap) => gap === gaps[0]);
    const widths = new Set(fixed.map((field) => field.widthBits));
    if (uniform && widths.size === 1 && gaps[0] === BigInt(fixed[0].byteWidth)) {
      conflicts.push({
        kind: 'ambiguous-shape',
        detail: 'the accesses fit a struct of equal-width fields and an array of the same element width equally well',
        between: ['struct', 'array'],
      });
      candidates.push(candidate('array', [
        { tier: 'soft', fact: 'uniform-stride', detail: `fixed offsets are spaced ${gaps[0]} bytes apart at one width` },
      ], conflicts.map((entry) => entry.kind), {
        elementWidthBits: fixed[0].widthBits,
        strideBytes: gaps[0],
      }));
    }
  }

  // Array of struct: one index stride wide enough to hold the sub-offsets seen
  // inside it. Struct of array: several independent indexed runs.
  const strides = [...new Set(indexed.map((access) => access.strideBytes).filter((stride) => stride != null))];
  if (strides.length === 1 && fixed.length >= 2 && fixed.every((field) => field.offset != null && field.offset < strides[0])) {
    candidates.push(candidate('array-of-struct', [
      { tier: 'soft', fact: 'stride-holds-fields', detail: `the index stride is ${strides[0]} bytes and every fixed offset seen falls inside it` },
    ], conflicts.map((entry) => entry.kind), {
      strideBytes: strides[0],
      innerOffsets: Object.freeze([...new Set(fixed.map((field) => field.offset))].sort((left, right) => (left < right ? -1 : 1))),
    }));
  }
  if (strides.length >= 2) {
    candidates.push(candidate('struct-of-array', [
      { tier: 'soft', fact: 'multiple-strides', detail: `${strides.length} independent index strides are used from this base` },
    ], conflicts.map((entry) => entry.kind), {
      strides: Object.freeze(strides.map((stride) => stride)),
    }));
  }

  // A struct whose last field is also indexed is the flexible-array-member
  // shape. It is evidence on the struct candidate, not a fourth guess.
  if (candidates.some((entry) => entry.kind === 'struct') && indexed.length > 0 && fixed.length > 0) {
    const last = fixed.reduce((most, field) => (field.offset != null && (most == null || field.offset > most.offset) ? field : most), null);
    const tail = indexed.find((access) => access.offset != null && last != null && access.offset >= last.offset);
    if (tail != null) {
      conflicts.push({
        kind: 'flexible-array-tail',
        detail: `the highest fixed offset +${last.offset} is also reached with an index, which is the flexible-array-member shape`,
        between: ['struct', 'struct-with-flexible-array'],
      });
    }
  }

  // A field whose loaded value is used as a base elsewhere is an embedded
  // object reference; the child region is named rather than inlined.
  if (region.embeddedChildren.length > 0) {
    candidates.push(candidate('embedded-object', [
      { tier: 'soft', fact: 'field-used-as-base', detail: `${region.embeddedChildren.length} field(s) load a pointer that is used as a base elsewhere` },
    ], conflicts.map((entry) => entry.kind), {
      children: Object.freeze([...region.embeddedChildren]),
    }));
  }

  if (candidates.length === 0) {
    candidates.push(candidate('unknown', [], conflicts.map((entry) => entry.kind), {
      detail: 'the accesses seen from this base support no aggregate shape',
    }));
  }

  // A conflict discovered while deriving a later candidate has to apply to the
  // earlier ones too, so certainty is settled once, at the end, over the final
  // conflict set.
  const conflictKinds = conflicts.map((entry) => entry.kind);
  const settled = candidates.map((entry) => Object.freeze({
    ...entry,
    conflicts: Object.freeze([...conflictKinds]),
    certainty: certaintyOf([...entry.support], conflictKinds),
  }));
  return { candidates: settled, conflicts };
}

/** Publishes aggregate candidates. Rewrites nothing, decides nothing. */
export function runAggregatePass(context = {}, budget = {}, area = null) {
  if (area == null) throw new TypeError('phase8-aggregates-requires-staging-area');
  const analysis = context.analysis;
  const cfg = analysis?.get('cfg');
  const inductionFacts = analysis?.get('induction');
  const recoveredTypes = analysis?.get('types')?.recovered ?? null;
  const limits = { ...DEFAULT_LIMITS, ...(budget.limits ?? {}) };

  const abortedNow = () => {
    try { return typeof budget.shouldAbort === 'function' && budget.shouldAbort() === true; }
    catch { return true; }
  };

  const instructions = [];
  for (const block of cfg?.blocks ?? []) {
    for (const instruction of block.insts ?? []) {
      if (instruction?.op === 'load' || instruction?.op === 'store') instructions.push(instruction);
      if (instructions.length >= limits.maxAccesses) break;
    }
  }

  // Pointer strides proved by P8-4. Reading them here is the whole point of that
  // artifact: array recovery must not contain a second induction analyser.
  const strideByValue = new Map();
  for (const loop of inductionFacts?.loops ?? []) {
    for (const fact of loop.inductions) {
      if (fact.kind === 'pointer' && fact.step != null) strideByValue.set(fact.valueId, fact.step);
    }
  }

  const grouped = new Map();
  let budgetExhausted = false;
  for (const instruction of instructions) {
    if (abortedNow()) { budgetExhausted = true; break; }
    const identity = regionIdentityOf(instruction, limits);
    if (identity == null) continue;
    if (!grouped.has(identity.regionKey)) {
      grouped.set(identity.regionKey, { identity, accesses: [], bases: new Set() });
    }
    const group = grouped.get(identity.regionKey);
    const access = accessOf(instruction, limits);
    group.accesses.push(access);
    if (access.base?.id != null) group.bases.add(access.base.id);
  }

  const baseToRegion = new Map();
  for (const [regionKey, group] of grouped) {
    for (const id of group.bases) baseToRegion.set(id, regionKey);
  }

  const regions = [];
  for (const [regionKey, group] of [...grouped.entries()].sort((left, right) => left[0].localeCompare(right[0])).slice(0, limits.maxRegions)) {
    const accesses = group.accesses;
    const conflicts = [];

    // Fixed-offset observations, merged per offset. A field is an observation
    // about bytes, not a name; naming is a later, refinement-layer concern.
    const byOffset = new Map();
    for (const access of accesses) {
      if (access.indexed || access.offset == null) continue;
      const key = String(access.offset);
      if (!byOffset.has(key)) {
        byOffset.set(key, {
          offset: access.offset, widthBits: access.widthBits, byteWidth: access.byteWidth,
          reads: 0, writes: 0, origin: [],
        });
      }
      const field = byOffset.get(key);
      if (access.op === 'load') field.reads += 1; else field.writes += 1;
      for (const id of access.origin) if (!field.origin.includes(id)) field.origin.push(id);
      if (access.widthBits !== field.widthBits) {
        // Two widths at one offset is exactly the union/struct question. It is
        // recorded, and the wider observation is kept so the extent stays honest.
        conflicts.push({
          kind: 'width-disagreement',
          detail: `offset +${access.offset} is accessed at ${field.widthBits} and ${access.widthBits} bits`,
          between: [`${field.widthBits}b`, `${access.widthBits}b`],
        });
        if (access.widthBits > field.widthBits) { field.widthBits = access.widthBits; field.byteWidth = access.byteWidth; }
      }
    }
    const fields = [...byOffset.values()].sort((left, right) => (left.offset < right.offset ? -1 : left.offset > right.offset ? 1 : 0));

    // Gaps between fields are padding. They are reported as gaps, never filled
    // in with a field nobody observed.
    const padding = [];
    for (let index = 1; index < fields.length; index += 1) {
      const previousEnd = fields[index - 1].offset + BigInt(fields[index - 1].byteWidth);
      if (fields[index].offset > previousEnd) {
        padding.push(Object.freeze({ from: previousEnd, to: fields[index].offset, bytes: fields[index].offset - previousEnd }));
      }
    }

    const offsets = accesses.map((access) => access.offset).filter((offset) => offset != null);
    const extent = offsets.length === 0
      ? { minOffset: null, maxEndOffset: null, known: false }
      : {
        minOffset: offsets.reduce((least, offset) => (offset < least ? offset : least)),
        maxEndOffset: fields.reduce((most, field) => {
          const end = field.offset + BigInt(field.byteWidth);
          return most == null || end > most ? end : most;
        }, null),
        known: false,
      };
    // An access at a negative offset from the base has left the object it was
    // derived from. That is recorded, not absorbed.
    if (offsets.some((offset) => offset < 0n)) {
      conflicts.push({
        kind: 'boundary-crossing',
        detail: 'an access is at a negative offset from this base, so the pointer has left the region it was derived from',
        between: ['inside-region', 'outside-region'],
      });
    }

    // A field that loads a pointer used as a base somewhere else.
    const embeddedChildren = [];
    for (const access of accesses) {
      if (access.op !== 'load' || access.indexed) continue;
      const child = access.producedValueId != null ? baseToRegion.get(access.producedValueId) : null;
      if (child != null && child !== regionKey && !embeddedChildren.some((entry) => entry.regionKey === child)) {
        embeddedChildren.push(Object.freeze({ offset: access.offset, regionKey: child }));
      }
    }

    const nominalOf = (id) => {
      const recovered = id == null ? null : recoveredTypes?.values?.get?.(id) ?? null;
      const name = recovered?.className ?? recovered?.semanticType?.className ?? recovered?.pointee?.className ?? null;
      return name == null ? null : String(name).replace(/\s*\*$/, '');
    };
    const nominals = [...new Set([...group.bases].map(nominalOf).filter((name) => name != null))];
    if (nominals.length > 1) {
      // Two declarations that disagree stay two declarations.
      conflicts.push({
        kind: 'nominal-disagreement',
        detail: `the recovered types name this base ${nominals.join(' and ')}`,
        between: nominals,
      });
    }

    const inductionStride = [...group.bases].map((id) => strideByValue.get(id)).find((stride) => stride != null) ?? null;
    if (group.identity.tier === 'soft') {
      conflicts.push({
        kind: 'unproven-grouping',
        detail: group.identity.detail,
        between: ['one-object', 'several-objects'],
      });
    }

    const region = {
      regionKey,
      rootKind: group.identity.rootKind,
      groupingEvidence: [{ tier: group.identity.tier, fact: 'region-identity', detail: group.identity.detail }],
      accesses,
      fields,
      padding,
      extent,
      conflicts,
      nominal: nominals.length === 1 ? nominals[0] : null,
      // A recovered nominal name is an inference by the type layer, not a
      // declaration. It is soft until something declares it.
      nominalTier: 'soft',
      inductionStride,
      embeddedChildren,
    };
    const derived = candidatesFor(region);

    regions.push(Object.freeze({
      regionKey,
      rootKind: region.rootKind,
      groupingEvidence: Object.freeze(region.groupingEvidence.map((entry) => Object.freeze(entry))),
      accessCount: accesses.length,
      fields: Object.freeze(fields.map((field) => Object.freeze({
        offset: field.offset, widthBits: field.widthBits, reads: field.reads, writes: field.writes,
        origin: Object.freeze({ instructionIds: Object.freeze([...field.origin].sort()) }),
      }))),
      padding: Object.freeze(padding),
      extent: Object.freeze(extent),
      nominal: region.nominal,
      inductionStride,
      embeddedChildren: Object.freeze(embeddedChildren),
      candidates: Object.freeze(derived.candidates),
      conflicts: Object.freeze(derived.conflicts.map((entry) => Object.freeze({ ...entry, between: Object.freeze([...(entry.between ?? [])]) }))),
      completeness: budgetExhausted ? 'partial' : 'complete',
      origin: Object.freeze({ instructionIds: Object.freeze([...new Set(accesses.flatMap((access) => access.origin))].sort()) }),
    }));
  }

  const allCandidates = regions.flatMap((region) => region.candidates);
  const facts = Object.freeze({
    contractVersion: AGGREGATE_PASS.contractVersion,
    passVersion: AGGREGATE_PASS.version,
    summaryVersion: AGGREGATE_SUMMARY_VERSION,
    regions: Object.freeze(regions),
    regionCount: regions.length,
    candidateCount: allCandidates.length,
    // Regions that kept more than one shape rather than picking the best score.
    ambiguousRegionCount: regions.filter((region) => region.candidates.length > 1).length,
    conflictCount: regions.reduce((total, region) => total + region.conflicts.length, 0),
    confirmedCount: allCandidates.filter((entry) => entry.certainty === 'confirmed').length,
    supportedCount: allCandidates.filter((entry) => entry.certainty === 'supported').length,
    completeness: budgetExhausted ? 'partial' : 'complete',
  });
  area.stage('aggregates', facts);

  const diagnostics = [];
  if (budgetExhausted) {
    diagnostics.push({
      severity: 'warning',
      code: 'phase8.aggregates.budget',
      message: 'Aggregate recovery stopped before every access was grouped.',
      reason: 'The pass was cancelled; the regions published are a subset and must not be read as the whole layout.',
    });
  }
  if (facts.conflictCount > 0) {
    diagnostics.push({
      severity: 'info',
      code: 'phase8.aggregates.conflicts',
      message: `${facts.conflictCount} conflict(s) hold aggregate candidates below certainty.`,
      reason: [...new Set(regions.flatMap((region) => region.conflicts.map((entry) => entry.kind)))].slice(0, 4).join('; '),
    });
  }

  return createPassResult({
    descriptor: AGGREGATE_PASS,
    status: 'changed',
    changed: true,
    completeness: facts.completeness,
    transforms: [],
    produced: ['aggregates'],
    diagnostics,
    invalidated: [],
  });
}

/**
 * The independent certainty check.
 *
 * Recomputes, from the published evidence alone, whether any candidate was
 * allowed to be certain that should not have been. A candidate confirmed over a
 * conflict, confirmed without hard evidence, or a region with a hard
 * contradiction that published only one shape, is a forced contradiction.
 */
export function forcedContradictions(facts) {
  const forced = [];
  for (const region of facts?.regions ?? []) {
    const hardConflicts = region.conflicts.filter((entry) => entry.kind === 'nominal-disagreement' || entry.kind === 'width-disagreement');
    for (const entry of region.candidates) {
      if (entry.certainty === 'confirmed' && entry.conflicts.length > 0) {
        forced.push({ regionKey: region.regionKey, kind: entry.kind, problem: 'confirmed-over-conflict', detail: entry.conflicts.join(', ') });
      }
      if (entry.certainty === 'confirmed' && !entry.support.some((fact) => fact.tier === 'hard')) {
        forced.push({ regionKey: region.regionKey, kind: entry.kind, problem: 'confirmed-without-hard-evidence', detail: 'certainty was reached on soft evidence alone' });
      }
      if (!CERTAINTIES.includes(entry.certainty)) {
        forced.push({ regionKey: region.regionKey, kind: entry.kind, problem: 'unknown-certainty', detail: String(entry.certainty) });
      }
      if (!AGGREGATE_KINDS.includes(entry.kind)) {
        forced.push({ regionKey: region.regionKey, kind: entry.kind, problem: 'unknown-kind', detail: String(entry.kind) });
      }
    }
    if (hardConflicts.length > 0 && region.candidates.length === 1 && region.candidates[0].kind !== 'unknown') {
      forced.push({
        regionKey: region.regionKey,
        kind: region.candidates[0].kind,
        problem: 'contradiction-resolved-to-one-shape',
        detail: hardConflicts.map((entry) => entry.kind).join(', '),
      });
    }
  }
  return forced;
}

/** A readable summary of one region, for evidence. */
export function describeRegion(region) {
  if (region == null) return 'no region';
  const shapes = region.candidates.map((entry) => `${entry.kind}(${entry.certainty})`).join(', ');
  const conflicts = region.conflicts.length === 0 ? 'no conflict' : region.conflicts.map((entry) => entry.kind).join('/');
  return `${region.regionKey}: ${region.accessCount} access(es), ${shapes}; ${conflicts}`;
}
