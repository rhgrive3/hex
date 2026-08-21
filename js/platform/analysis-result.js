import { isExactFunctionSeed } from './worker-validation.js';

function provenance(source, confidence = 1) {
  return { source: source || 'binary-metadata', confidence, confirmed: true };
}

function statusReasons(value, prefix, out) {
  if (!value || typeof value !== 'object') return;
  if (value.complete === false) out.push(`${prefix}:incomplete`);
  if (value.importsComplete === false) out.push(`${prefix}:imports-incomplete`);
  if (value.symbolsComplete === false) out.push(`${prefix}:symbols-incomplete`);
  if (value.bindingSitesComplete === false) out.push(`${prefix}:binding-sites-incomplete`);
  for (const reason of [value.partialReason, value.importsPartialReason, value.symbolsPartialReason, value.bindingSitesPartialReason]) {
    if (reason) out.push(`${prefix}:${reason}`);
  }
  for (const reason of value.reasons || []) out.push(`${prefix}:${reason}`);
  for (const reason of value.bindingSiteReasons || []) out.push(`${prefix}:${reason}`);
}

function dyldBindingReasons(value, out) {
  if (!value || typeof value !== 'object') return;
  statusReasons(value, 'dyld-bindings', out);
  const streams = value.streams && typeof value.streams === 'object' ? value.streams : value;
  for (const [kind, status] of Object.entries(streams)) {
    if (kind === 'complete' || kind === 'streams') continue;
    statusReasons(status, `dyld-${kind}`, out);
  }
}

export function machoSymbolTruth(image) {
  if (!image || image.format !== 'macho') return null;
  const metadata = image.metadata || {};
  const reasons = [];
  statusReasons(metadata.machoMetadata, 'metadata-budget', reasons);
  statusReasons(metadata.chainedFixups, 'chained-fixups', reasons);
  statusReasons(metadata.exportTrie, 'export-trie', reasons);
  dyldBindingReasons(metadata.dyldBindings, reasons);
  const unique = [...new Set(reasons)].slice(0, 64);
  return {
    source: 'BinaryImage', normalized: true, complete: unique.length === 0, reasons: unique,
    components: {
      chainedFixups: metadata.chainedFixups || null,
      dyldBindings: metadata.dyldBindings || null,
      exportTrie: metadata.exportTrie || null,
      metadataBudget: metadata.machoMetadata || null,
    },
  };
}

function u64Address(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('analysis-address-unsafe-number');
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (!text || !/^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(text)) throw new TypeError('analysis-address-invalid-string');
    value = text;
  } else if (typeof value !== 'bigint') {
    throw new TypeError('analysis-address-invalid');
  }
  const addr = BigInt(value);
  if (addr < 0n || addr > 0xffffffffffffffffn) throw new RangeError('analysis-address-out-of-range');
  return addr;
}

export function analysisFromBinaryImage(image) {
  if (!image) return emptyAnalysis();
  const entries = new Map();
  const add = (address, name, kind, exported, prov, priority) => {
    if (address == null || !name) return;
    const addr = u64Address(address), key = addr.toString();
    const next = { address: addr, name: String(name), kind, exported: !!exported, provenance: prov, priority };
    const current = entries.get(key);
    if (!current) { entries.set(key, next); return; }
    current.exported ||= next.exported;
    if (next.priority > current.priority) {
      current.name = next.name; current.kind = next.kind; current.provenance = next.provenance; current.priority = next.priority;
    }
  };

  for (const symbol of image.symbols || []) {
    if (symbol?.defined === false || symbol?.address == null || !symbol.name) continue;
    add(symbol.address, symbol.name, 0, !!symbol.exported, provenance(symbol.source || 'symbol-table', 0.99), 10);
  }
  for (const exp of image.exports || []) {
    if (exp?.address == null || !exp.name) continue;
    add(exp.address, exp.name, 0, true, provenance(exp.source || 'exports-trie', 1), 20);
  }
  for (const imp of image.imports || []) {
    if (!imp?.name) continue;
    for (const site of imp.sites || []) {
      if (site?.address == null) continue;
      add(site.address, imp.name, 2, false, provenance(site.kind || imp.source || 'dyld-bind', 1), 30);
    }
  }

  const sorted = [...entries.values()].sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  const addrs = new BigUint64Array(sorted.length), kinds = new Uint8Array(sorted.length), flags = new Uint8Array(sorted.length);
  for (let i = 0; i < sorted.length; i++) { addrs[i] = sorted[i].address; kinds[i] = sorted[i].kind; flags[i] = sorted[i].exported ? 1 : 0; }

  const seedByAddress = new Map();
  for (const seed of image.functions || []) if (seed?.address != null) seedByAddress.set(u64Address(seed.address).toString(), seed);
  const functions = [...seedByAddress.keys()].map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const funcs = new BigUint64Array(functions);
  const functionProvenance = functions.map((addr) => {
    const seed = seedByAddress.get(addr.toString()) || {};
    const confirmed = isExactFunctionSeed(seed);
    return { source: seed.source || 'heuristic', confidence: Number(seed.confidence ?? (confirmed ? 1 : 0.5)), confirmed };
  });
  const nameProvenance = sorted.map((entry) => entry.provenance);
  const allSeedsExact = functions.length > 0 && (image.functions || []).every(isExactFunctionSeed);
  const discoveryComplete = image.metadata?.functionDiscovery?.complete === true;
  return {
    addrs, kinds, flags, names: sorted.map((x) => x.name), funcs, functionProvenance, nameProvenance,
    symbolCount: addrs.length, funcCount: funcs.length, capped: false,
    allSeedsExact, discoveryComplete, functionStartsExact: discoveryComplete && allSeedsExact,
    functionDiscovery: { complete: discoveryComplete, capped: false, reasons: discoveryComplete ? [] : ['platform-function-seeds-not-exhaustive'] },
    symbolTruth: machoSymbolTruth(image),
    __transfer: [addrs.buffer, kinds.buffer, flags.buffer, funcs.buffer],
  };
}

export function emptyAnalysis() {
  const addrs = new BigUint64Array(0), kinds = new Uint8Array(0), flags = new Uint8Array(0), funcs = new BigUint64Array(0);
  return {
    addrs, kinds, flags, names: [], funcs, symbolCount: 0, funcCount: 0, capped: false,
    allSeedsExact: false, discoveryComplete: false, functionStartsExact: false,
    functionDiscovery: { complete:false, capped:false, reasons:['platform-function-seeds-not-exhaustive'] },
    symbolTruth: null,
    __transfer: [addrs.buffer, kinds.buffer, flags.buffer, funcs.buffer],
  };
}
