/**
 * P7-6 — evidence producers.
 *
 * The producers here are the *generic* ones: they read structures that mean the
 * same thing on every architecture (loader tables, unwind entries, symbols,
 * exports, relocation targets, call edges in the semantic IR). None of them
 * decodes an instruction.
 *
 * Architecture-specific producers — prologue recognition above all — belong
 * behind the target boundary, which Phase 7 does not own. What Phase 7 supplies
 * is the contract they implement and, for the cases where a pattern really is
 * just data, a declarative byte-pattern producer that takes its patterns from
 * the caller instead of hard-coding any architecture's encoding.
 */

import { EVIDENCE_AUTHORITY, createDiscoveryEvidence } from './candidates.js';
import { regionFromSize } from './fusion.js';

function toAddress(value) {
  if (value == null) return null;
  try { return BigInt(value).toString(); }
  catch { return null; }
}

function evidence(kind, input) {
  if (!EVIDENCE_AUTHORITY[kind]) throw new TypeError(`discovery-producer-unknown-kind:${kind}`);
  return createDiscoveryEvidence({ kind, ...input });
}

/**
 * Loader-supplied function starts and unwind entries.
 *
 * `image.functionStarts` and `image.unwindEntries` are already
 * format-normalised by the loader; a Mach-O LC_FUNCTION_STARTS table, an ELF
 * `.eh_frame` FDE list and a PE `.pdata` entry all arrive here in the same
 * shape, which is why one producer covers all three formats.
 */
export const loaderProducer = Object.freeze({
  id: 'discovery.loader',
  architectureId: null,
  produce(input) {
    const out = [];
    for (const start of input?.image?.functionStarts ?? []) {
      const address = toAddress(start.address ?? start);
      if (address == null) continue;
      const region = start.sizeBytes ? regionFromSize(address, start.sizeBytes) : null;
      out.push(evidence('loader-function-start', {
        start: address,
        name: start.name ?? null,
        regions: region ? [region] : [],
        evidenceIds: [`loader:start:${address}`],
      }));
    }
    // A function body can be split across several unwind entries; the loader
    // marks the continuations and names the range they belong to. Those are
    // *not* separate function starts, and treating them as such is a false
    // split — so they contribute a partial extent to their owner instead.
    const unwindEntries = input?.image?.unwindEntries ?? [];
    const ownersWithContinuations = new Set(
      unwindEntries
        .filter((entry) => entry.primary === false && entry.ownerStart != null)
        .map((entry) => toAddress(entry.ownerStart))
        .filter(Boolean),
    );
    for (const entry of unwindEntries) {
      const isContinuation = entry.primary === false && entry.ownerStart != null;
      const address = isContinuation ? toAddress(entry.ownerStart) : toAddress(entry.start ?? entry.address);
      if (address == null) continue;
      const rangeStart = toAddress(entry.start ?? entry.address);
      const region = entry.end != null
        ? { start: rangeStart, end: BigInt(entry.end), ownership: 'exclusive' }
        : entry.sizeBytes != null ? regionFromSize(rangeStart, entry.sizeBytes) : null;
      out.push(evidence('unwind-entry', {
        start: address,
        regions: region ? [region] : [],
        extentRole: isContinuation || ownersWithContinuations.has(address) ? 'partial' : 'complete',
        evidenceIds: [`unwind:${rangeStart}`],
      }));
    }
    return out;
  },
});

/** Exports and the image entrypoint. */
export const exportProducer = Object.freeze({
  id: 'discovery.exports',
  architectureId: null,
  produce(input) {
    const out = [];
    for (const entry of input?.image?.exports ?? []) {
      const address = toAddress(entry.address);
      if (address == null) continue;
      out.push(evidence('export', { start: address, name: entry.name ?? null, evidenceIds: [`export:${address}`] }));
    }
    const entrypoint = toAddress(input?.image?.entrypoint);
    if (entrypoint != null) {
      out.push(evidence('entrypoint', { start: entrypoint, name: 'entrypoint', evidenceIds: [`entrypoint:${entrypoint}`] }));
    }
    return out;
  },
});

/**
 * Symbol-table entries.
 *
 * Corroborating rather than authoritative: a symbol table can carry labels that
 * are not function starts, and a stripped-then-partially-restored table is a
 * common source of plausible-looking wrong starts.
 */
export const symbolTableProducer = Object.freeze({
  id: 'discovery.symbols',
  architectureId: null,
  produce(input) {
    const out = [];
    for (const symbol of input?.image?.symbols ?? []) {
      const address = toAddress(symbol.address);
      if (address == null || symbol.isFunction === false) continue;
      const region = symbol.sizeBytes ? regionFromSize(address, symbol.sizeBytes) : null;
      out.push(evidence('symbol-table', {
        start: address,
        name: symbol.name ?? null,
        regions: region ? [region] : [],
        evidenceIds: [`symbol:${address}`],
      }));
    }
    return out;
  },
});

/** Relocation and vtable targets. */
export const referenceProducer = Object.freeze({
  id: 'discovery.references',
  architectureId: null,
  produce(input) {
    const out = [];
    for (const target of input?.image?.relocationTargets ?? []) {
      const address = toAddress(target.address ?? target);
      if (address == null) continue;
      out.push(evidence('relocation-target', { start: address, evidenceIds: [`reloc:${address}`] }));
    }
    for (const target of input?.image?.vtableEntries ?? []) {
      const address = toAddress(target.address ?? target);
      if (address == null) continue;
      out.push(evidence('vtable-entry', { start: address, evidenceIds: [`vtable:${address}`] }));
    }
    for (const target of input?.image?.exceptionMetadata ?? []) {
      const address = toAddress(target.address ?? target);
      if (address == null) continue;
      out.push(evidence('exception-metadata', { start: address, evidenceIds: [`eh:${address}`] }));
    }
    return out;
  },
});

/**
 * Direct call targets taken from the semantic IR.
 *
 * This is generic despite being derived from code: the IR's `call` node and its
 * target entity are architecture-neutral by construction, so no instruction
 * text is read here.
 */
export const callGraphProducer = Object.freeze({
  id: 'discovery.call-targets',
  architectureId: null,
  produce(input) {
    const out = [];
    for (const call of input?.callTargets ?? []) {
      const address = toAddress(call.address);
      if (address == null) continue;
      out.push(evidence('direct-call-target', {
        start: address,
        name: call.name ?? null,
        evidenceIds: [`call:${call.callSiteId ?? address}`],
      }));
    }
    return out;
  },
});

/** Debug-provider symbols, already gated by identity at the provider boundary. */
export function createDebugEvidenceProducer(debugEvidence) {
  return Object.freeze({
    id: 'discovery.debug',
    architectureId: null,
    produce() {
      return (debugEvidence ?? []).map((item) => evidence('debug-symbol', {
        start: toAddress(item.address),
        name: item.name ?? null,
        regions: item.sizeBytes ? [regionFromSize(item.address, item.sizeBytes)].filter(Boolean) : [],
        confidence: item.confidence,
        evidenceIds: item.evidenceIds ?? [],
      })).filter((item) => item.start != null);
    },
  });
}

/**
 * A declarative byte-pattern producer.
 *
 * The patterns are *data supplied by the caller*, not knowledge held here. An
 * architecture boundary that knows its own prologue encodings can register one
 * of these without Phase 7 learning anything about that architecture, which is
 * what keeps the generic solver honest (P7-INV-007, FM-9).
 *
 * Output is always `heuristic`: a byte pattern alone never establishes a start.
 */
export function createPatternProducer({ id, architectureId, patterns, alignment = 1 }) {
  if (!Number.isSafeInteger(alignment) || alignment <= 0) {
    throw new TypeError('discovery-pattern-invalid-alignment');
  }
  if (!Array.isArray(patterns)) {
    throw new TypeError('discovery-pattern-empty-patterns');
  }
  const compiled = patterns.map((pattern) => {
    if (!pattern || (!Array.isArray(pattern.bytes) && !(pattern.bytes instanceof Uint8Array)) || pattern.bytes.length === 0) {
      throw new TypeError('discovery-pattern-invalid-bytes');
    }
    const bytes = Uint8Array.from(pattern.bytes);
    let mask = null;
    if (pattern.mask) {
      if (pattern.mask.length !== bytes.length) {
        throw new TypeError('discovery-pattern-mask-length-mismatch');
      }
      mask = Uint8Array.from(pattern.mask);
    }
    return {
      id: String(pattern.id ?? 'pattern'),
      bytes,
      mask,
    };
  });
  return Object.freeze({
    id: String(id),
    architectureId: architectureId == null ? null : String(architectureId),
    produce(input) {
      const bytes = input?.image?.code;
      const base = input?.image?.codeBaseAddress;
      if (!bytes || base == null || compiled.length === 0) return [];
      const baseAddress = BigInt(base);
      const out = [];
      for (let offset = 0; offset + 1 <= bytes.length; offset += alignment) {
        for (const pattern of compiled) {
          if (offset + pattern.bytes.length > bytes.length) continue;
          let matched = true;
          for (let index = 0; index < pattern.bytes.length; index += 1) {
            const mask = pattern.mask ? pattern.mask[index] : 0xff;
            if ((bytes[offset + index] & mask) !== (pattern.bytes[index] & mask)) { matched = false; break; }
          }
          if (!matched) continue;
          out.push(evidence('prologue-candidate', {
            start: (baseAddress + BigInt(offset)).toString(),
            evidenceIds: [`pattern:${pattern.id}:${offset}`],
          }));
          break;
        }
      }
      return out;
    },
  });
}

export const GENERIC_PRODUCERS = Object.freeze([
  loaderProducer,
  exportProducer,
  symbolTableProducer,
  referenceProducer,
  callGraphProducer,
]);
