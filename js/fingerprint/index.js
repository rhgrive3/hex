const MASK64 = 0xffffffffffffffffn;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
export const FUNCTION_FINGERPRINT_VERSION = 2;

function hashBytes(bytes) {
  if (!bytes || !bytes.length) return null;
  let hash = FNV_OFFSET;
  for (const b of bytes) { hash ^= BigInt(b); hash = (hash * FNV_PRIME) & MASK64; }
  return hash.toString(16).padStart(16, '0');
}
function hashText(text) { return text ? hashBytes(new TextEncoder().encode(text)) : null; }
function stable(value) {
  if (value == null) return 'null';
  if (typeof value === 'bigint') return JSON.stringify({ $bigint: value.toString() });
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
}
function uniq(values) {
  return [...new Set((values || []).filter((v) => v != null && String(v).length).map((v) => String(v)))].sort();
}
function numericUniq(values) {
  return [...new Set((values || []).filter((v) => v != null).map((v) => typeof v === 'bigint' ? v.toString() : String(v)))].sort();
}
function nonEmptyHash(value) {
  if (value == null) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return null;
  return hashText(stable(value));
}

const IGNORABLE_MNEMONICS = new Set(['nop', 'bti', 'paciasp', 'pacibsp', 'autiasp', 'autibsp', 'xpaclri']);
const BRANCH_MNEMONICS = /^(b(\.|$)|bl$|blr$|cbn?z$|tbn?z$)/;
const ADDRESS_MNEMONICS = /^(adrp?|ldr|str|ldp|stp)$/;
const REGEX_REG = /\b([xwvsdqhb])(\d{1,2})\b/gi;
const IMM_HEX = /#?0x[0-9a-f]+/gi;

export function normalizeInstruction(instruction, options = {}) {
  let mnemonic, operands;
  if (typeof instruction === 'string') {
    const m = /^\s*([a-z0-9.]+)\s*(.*)$/i.exec(instruction);
    mnemonic = (m?.[1] || '').toLowerCase(); operands = m?.[2] || '';
  } else {
    mnemonic = String(instruction?.mnemonic || instruction?.op || '').toLowerCase();
    operands = String(instruction?.opStr ?? instruction?.operands ?? '');
  }
  if (!mnemonic) return null;
  if (options.ignoreCompilerNoise !== false && IGNORABLE_MNEMONICS.has(mnemonic)) return null;
  let normalized = operands
    .replace(/\b(fp|x29)\b/gi, 'FP')
    .replace(/\b(lr|x30)\b/gi, 'LR')
    .replace(/\bsp\b/gi, 'SP')
    .replace(REGEX_REG, (_m, cls) => `${cls.toLowerCase()}R`);
  // Stack-frame placement is a compiler choice; object/field offsets are not.
  normalized = normalized.replace(/\[(SP|FP)\s*,\s*(#?-?(?:0x[0-9a-f]+|\d+))\]/gi, '[$1,@stack]');
  if (/^(add|sub)$/.test(mnemonic) && /^SP\s*,\s*SP\s*,/i.test(normalized)) normalized = normalized.replace(/#?-?(?:0x[0-9a-f]+|\d+)/i, '@frame');
  if (BRANCH_MNEMONICS.test(mnemonic)) normalized = normalized.replace(IMM_HEX, '@branch');
  else if (/^adrp?$/.test(mnemonic)) normalized = normalized.replace(IMM_HEX, '@address');
  else if (ADDRESS_MNEMONICS.test(mnemonic) && !normalized.includes('[')) {
    normalized = normalized.replace(IMM_HEX, (raw) => {
      const value = Number.parseInt(raw.replace('#', ''), 16);
      return Number.isFinite(value) && Math.abs(value) >= 0x1000 ? '@address' : raw;
    });
  }
  return { mnemonic, operands: normalized.replace(/\s+/g, ' ').trim() };
}

export function normalizeRelocations(bytes, relocationOffsets = [], relocationRanges = []) {
  if (!bytes || !bytes.length) return null;
  const out = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
  const ranges = [];
  for (const raw of relocationOffsets || []) {
    const offset = Number(typeof raw === 'object' ? raw.offset : raw);
    const width = Number(typeof raw === 'object' ? raw.width ?? 8 : 8);
    ranges.push({ offset, width });
  }
  for (const raw of relocationRanges || []) ranges.push({ offset: Number(raw.offset), width: Number(raw.width ?? raw.size ?? 8) });
  for (const { offset, width } of ranges) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(width) || offset < 0 || width <= 0 || offset >= out.length) continue;
    out.fill(0, offset, Math.min(out.length, offset + Math.min(width, 16)));
  }
  return out;
}

function cfgShape(cfg = {}) {
  const blocks = Array.isArray(cfg.blocks) ? cfg.blocks.length : Math.max(0, Number(cfg.blocks || 0));
  const edges = Array.isArray(cfg.edges) ? cfg.edges.length : Math.max(0, Number(cfg.edges || 0));
  const exits = Array.isArray(cfg.exits) ? cfg.exits.length : Math.max(0, Number(cfg.exits || 0));
  const loops = Array.isArray(cfg.loops) ? cfg.loops.length : Math.max(0, Number(cfg.loops || 0));
  const calls = Math.max(0, Number(cfg.calls || 0));
  return { blocks, edges, exits, loops, calls };
}
function blockHashes(cfg = {}) {
  if (!Array.isArray(cfg.blocks)) return [];
  return cfg.blocks.map((block) => {
    const instructions = (block.instructions || block.insns || []).map((x) => normalizeInstruction(x)).filter(Boolean);
    const descriptor = {
      instructions: instructions.map((x) => x.mnemonic),
      operands: instructions.map((x) => x.operands),
      successors: Array.isArray(block.successors) ? block.successors.length : Number(block.outDegree || 0),
    };
    return hashText(stable(descriptor));
  }).filter(Boolean).sort();
}
function semanticShape(input = {}) {
  const sem = input.semantic || input.irSemantic || {};
  return {
    reads: uniq(sem.reads ?? input.reads), writes: uniq(sem.writes ?? input.writes),
    rmw: uniq(sem.rmw ?? input.rmw), calls: uniq(sem.calls ?? input.semanticCalls),
    returnOrigin: sem.returnOrigin ?? input.returnOrigin ?? null,
    fieldShape: uniq(sem.fieldShape ?? input.fieldAccessShape),
    controlFlow: sem.controlFlow ?? input.semanticControlFlow ?? null,
    thresholds: numericUniq(sem.thresholds ?? input.thresholds),
    operations: uniq(sem.operations ?? input.operations),
  };
}
function stackShape(input = {}) {
  const stack = input.stackShape || input.stack || {};
  if (!stack || (typeof stack === 'object' && !Object.keys(stack).length)) return null;
  return {
    frameSize: stack.frameSize == null ? null : Number(stack.frameSize),
    saved: uniq(stack.savedRegisters || stack.saved),
    locals: stack.locals == null ? null : Number(stack.locals),
    args: stack.args == null ? null : Number(stack.args),
  };
}

export function fingerprintFunction(fn = {}, options = {}) {
  if (fn?.schema === 'hex.function-fingerprint' && fn.version >= 2 && options.includeSemantic !== false) return fn;
  const bytes = fn.bytes == null ? null : (fn.bytes instanceof Uint8Array ? fn.bytes : new Uint8Array(fn.bytes));
  const normalizedBytes = normalizeRelocations(bytes, fn.relocationOffsets, fn.relocationRanges);
  const instructions = (fn.instructions || []).map((x) => normalizeInstruction(x, fn.normalization)).filter(Boolean);
  const mnemonics = instructions.map((x) => x.mnemonic);
  const operands = instructions.map((x) => `${x.mnemonic} ${x.operands}`.trim());
  const cfg = cfgShape(fn.cfg);
  const blocks = blockHashes(fn.cfg);
  const semantic = options.includeSemantic === false ? semanticShape({}) : semanticShape(fn);
  const strings = uniq(fn.strings), imports = uniq(fn.imports), calls = uniq(fn.calls), callees = uniq(fn.callees), callers = uniq(fn.callers);
  const constants = numericUniq(fn.constants), fields = uniq([...(fn.fieldAccessShape || []), ...(semantic.fieldShape || [])]), selectors = uniq(fn.objcSelectors ?? fn.selectors), swiftMetadata = uniq(fn.swiftMetadata);
  const runtimeMetadata = uniq(fn.runtimeMetadata), stack = stackShape(fn);
  const objc = { class: fn.objcClass || fn.objc?.class || null, selector: fn.objcSelector || fn.objc?.selector || null, methodKind: fn.objcMethodKind || fn.objc?.methodKind || null, selectors: uniq([...(selectors || []), ...(fn.objc?.selectors || [])]), ivars: uniq(fn.objcIvars || fn.objc?.ivars), protocols: uniq(fn.objcProtocols || fn.objc?.protocols), categories: uniq(fn.objcCategories || fn.objc?.categories), messageSendProfile: uniq(fn.objcMessageSendProfile || fn.messageSendProfile || fn.objc?.messageSendProfile) };
  const swift = { typeDescriptor: fn.swiftTypeDescriptor || fn.swift?.typeDescriptor || null, conformances: uniq(fn.swiftConformances || fn.swift?.conformances), witnessUsage: uniq(fn.swiftWitnessUsage || fn.swift?.witnessUsage), vtableUsage: uniq(fn.swiftVtableUsage || fn.swift?.vtableUsage), metadataAccessors: uniq(fn.swiftMetadataAccessors || fn.swift?.metadataAccessors), runtimeCalls: uniq(fn.swiftRuntimeCalls || fn.swift?.runtimeCalls), metadata: uniq([...(swiftMetadata || []), ...(fn.swift?.metadata || [])]) };
  const size = Math.max(0, Number(fn.size ?? bytes?.length ?? 0));
  const architecture = String(fn.architecture || fn.arch || 'unknown').toLowerCase();
  const exactBytesHash = bytes?.length ? hashBytes(bytes) : (fn.exactBytesHash || fn.byteHash || null);
  const normalizedBytesHash = normalizedBytes?.length ? hashBytes(normalizedBytes) : (fn.normalizedBytesHash || fn.normalizedByteHash || null);
  const instructionSequenceHash = mnemonics.length ? nonEmptyHash(mnemonics) : (fn.instructionSequenceHash || null);
  const instructionBagHash = mnemonics.length ? nonEmptyHash([...mnemonics].sort()) : (fn.instructionBagHash || null);
  const normalizedOperandsHash = operands.length ? nonEmptyHash(operands) : (fn.normalizedOperandsHash || null);
  const normalizedOperandBagHash = operands.length ? nonEmptyHash([...operands].sort()) : (fn.normalizedOperandBagHash || null);
  const cfgHash = (cfg.blocks || cfg.edges || cfg.exits || cfg.loops || cfg.calls) ? nonEmptyHash({ cfg, blocks }) : (fn.cfgHash || null);
  const semanticHash = options.includeSemantic === false ? null : (Object.values(semantic).some((v) => Array.isArray(v) ? v.length : v != null) ? nonEmptyHash(semantic) : (fn.semanticHash || fn.irHash || null));
  const components = {
    normalizedBytesHash, instructionSequenceHash, instructionBagHash, normalizedOperandsHash, normalizedOperandBagHash, cfgHash, semanticHash,
    strings: strings.length ? nonEmptyHash(strings) : null,
    imports: imports.length ? nonEmptyHash(imports) : null,
    calls: calls.length ? nonEmptyHash(calls) : null,
    constants: constants.length ? nonEmptyHash(constants) : null,
    objc: Object.values(objc).some((v) => Array.isArray(v) ? v.length : v != null) ? nonEmptyHash(objc) : null,
    swift: Object.values(swift).some((v) => Array.isArray(v) ? v.length : v != null) ? nonEmptyHash(swift) : null,
  };
  const strong = Object.values(components).filter(Boolean);
  const hash = strong.length ? nonEmptyHash({ architecture, size, components }) : null;
  return Object.freeze({
    schema: 'hex.function-fingerprint', version: FUNCTION_FINGERPRINT_VERSION,
    address: fn.address == null ? null : BigInt(fn.address), name: fn.name || null, architecture, size,
    exactBytesHash, byteHash: exactBytesHash, normalizedBytesHash, normalizedByteHash: normalizedBytesHash,
    byteSample: normalizedBytes ? Array.from(normalizedBytes.subarray(0, Math.min(256, normalizedBytes.length))) : Array.from(fn.byteSample || []),
    instructionSequenceHash, instructionBagHash, normalizedOperandsHash, normalizedOperandBagHash, cfgHash, basicBlockHashes: blocks, semanticHash, irHash: semanticHash,
    cfg, semantic, constants, strings, imports, calls, callees, callers, fieldAccessShape: fields, stackShape: stack,
    runtimeMetadata, objc, swift,
    hash,
  });
}

export function fingerprintFunctionFast(fn = {}) {
  if (fn?.schema === 'hex.function-fingerprint-fast' && fn.version >= 2) return fn;
  const source = fn?.schema === 'hex.function-fingerprint' ? fn : null;
  if (source) {
    return Object.freeze({ schema:'hex.function-fingerprint-fast', version:FUNCTION_FINGERPRINT_VERSION, address:source.address, name:source.name, architecture:source.architecture, size:source.size,
      exactBytesHash:source.exactBytesHash, byteHash:source.byteHash, normalizedBytesHash:source.normalizedBytesHash, normalizedByteHash:source.normalizedByteHash,
      instructionSequenceHash:source.instructionSequenceHash, instructionBagHash:source.instructionBagHash, normalizedOperandsHash:source.normalizedOperandsHash, normalizedOperandBagHash:source.normalizedOperandBagHash,
      cfgHash:source.cfgHash, cfg:source.cfg, strings:(source.strings||[]).slice(0,4), imports:(source.imports||[]).slice(0,4), semanticHash:null,
      objc:{ selector:source.objc?.selector || null }, swift:{ typeDescriptor:source.swift?.typeDescriptor || null } });
  }
  const bytes = fn.bytes == null ? null : (fn.bytes instanceof Uint8Array ? fn.bytes : new Uint8Array(fn.bytes));
  const normalizedBytes = normalizeRelocations(bytes, fn.relocationOffsets, fn.relocationRanges);
  const instructions = (fn.instructions || []).map((x) => normalizeInstruction(x, fn.normalization)).filter(Boolean);
  const mnemonics = instructions.map((x) => x.mnemonic), operands = instructions.map((x) => `${x.mnemonic} ${x.operands}`.trim());
  const cfg = cfgShape(fn.cfg), blocks = blockHashes(fn.cfg);
  const size = Math.max(0, Number(fn.size ?? bytes?.length ?? 0));
  const architecture = String(fn.architecture || fn.arch || 'unknown').toLowerCase();
  const exactBytesHash = bytes?.length ? hashBytes(bytes) : (fn.exactBytesHash || fn.byteHash || null);
  const normalizedBytesHash = normalizedBytes?.length ? hashBytes(normalizedBytes) : (fn.normalizedBytesHash || fn.normalizedByteHash || null);
  const instructionSequenceHash = mnemonics.length ? nonEmptyHash(mnemonics) : (fn.instructionSequenceHash || null);
  const instructionBagHash = mnemonics.length ? nonEmptyHash([...mnemonics].sort()) : (fn.instructionBagHash || null);
  const normalizedOperandsHash = operands.length ? nonEmptyHash(operands) : (fn.normalizedOperandsHash || null);
  const normalizedOperandBagHash = operands.length ? nonEmptyHash([...operands].sort()) : (fn.normalizedOperandBagHash || null);
  const cfgHash = (cfg.blocks || cfg.edges || cfg.exits || cfg.loops || cfg.calls) ? nonEmptyHash({cfg,blocks}) : (fn.cfgHash || null);
  return Object.freeze({ schema:'hex.function-fingerprint-fast', version:FUNCTION_FINGERPRINT_VERSION,
    address:fn.address==null?null:BigInt(fn.address), name:fn.name||null, architecture, size, exactBytesHash, byteHash:exactBytesHash, normalizedBytesHash, normalizedByteHash:normalizedBytesHash,
    instructionSequenceHash, instructionBagHash, normalizedOperandsHash, normalizedOperandBagHash, cfgHash, cfg,
    strings:uniq(fn.strings).slice(0,4), imports:uniq(fn.imports).slice(0,4), semanticHash:null,
    objc:{selector:fn.objcSelector||fn.objc?.selector||null}, swift:{typeDescriptor:fn.swiftTypeDescriptor||fn.swift?.typeDescriptor||null} });
}

function jaccard(a, b) {
  if (!a?.length || !b?.length) return null;
  const A = new Set(a), B = new Set(b); let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / (A.size + B.size - hit || 1);
}
function ratio(a, b) {
  a = Number(a || 0); b = Number(b || 0);
  if (!(a > 0) || !(b > 0)) return null;
  return Math.min(a, b) / Math.max(a, b);
}
function byteSampleSimilarity(a, b) {
  if (!a?.length || !b?.length) return null;
  const n = Math.max(a.length, b.length); let same = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) same++;
  return same / n;
}
function cfgSimilarity(a, b) {
  const keys = ['blocks', 'edges', 'exits', 'loops', 'calls'];
  const scores = keys.map((k) => ratio(a?.[k], b?.[k])).filter((x) => x != null);
  return scores.length ? scores.reduce((s, x) => s + x, 0) / scores.length : null;
}
function profileBag(profile = {}) {
  const out = [];
  for (const [key, value] of Object.entries(profile || {})) {
    if (Array.isArray(value)) for (const item of value) out.push(`${key}:${item}`);
    else if (value != null && String(value).length) out.push(`${key}:${value}`);
  }
  return out.sort();
}
function add(evidence, signal, value, weight, group, exact = false) {
  if (value == null || Number.isNaN(value)) return;
  evidence.push({ signal, value: Math.max(0, Math.min(1, value)), weight, group, exact });
}

export function compareFingerprints(left, right) {
  const a = fingerprintFunction(left), b = fingerprintFunction(right);
  if (a.architecture !== 'unknown' && b.architecture !== 'unknown' && a.architecture !== b.architecture) {
    return { confidence: 0, identity: 'unrelated', reasons: ['architecture-mismatch'], evidence: [{ signal: 'architecture-mismatch', value: 0, weight: 1, group: 'hard' }] };
  }
  if (a.exactBytesHash && b.exactBytesHash && a.size > 0 && b.size > 0 && a.exactBytesHash === b.exactBytesHash) {
    return { confidence: 1, identity: 'exact', reasons: ['exact-bytes'], evidence: [{ signal: 'exact-bytes', value: 1, weight: 1, group: 'bytes', exact: true }] };
  }
  const evidence = [];
  const normalizedExact = !!a.normalizedBytesHash && a.normalizedBytesHash === b.normalizedBytesHash && a.size > 0 && b.size > 0;
  add(evidence, 'normalized-bytes', normalizedExact ? 1 : null, 0.46, 'bytes', normalizedExact);
  if (!normalizedExact) add(evidence, 'byte-similarity', byteSampleSimilarity(a.byteSample, b.byteSample), 0.42, 'bytes');
  add(evidence, 'instruction-sequence', a.instructionSequenceHash && b.instructionSequenceHash ? (a.instructionSequenceHash === b.instructionSequenceHash ? 1 : 0) : null, 0.24, 'instruction');
  add(evidence, 'instruction-bag', a.instructionBagHash && b.instructionBagHash ? (a.instructionBagHash === b.instructionBagHash ? 1 : 0) : null, 0.10, 'instruction');
  add(evidence, 'normalized-operands', a.normalizedOperandsHash && b.normalizedOperandsHash ? (a.normalizedOperandsHash === b.normalizedOperandsHash ? 1 : 0) : null, 0.12, 'instruction');
  add(evidence, 'normalized-operand-bag', a.normalizedOperandBagHash && b.normalizedOperandBagHash ? (a.normalizedOperandBagHash === b.normalizedOperandBagHash ? 1 : 0) : null, 0.08, 'instruction');
  add(evidence, 'semantic-ir', a.semanticHash && b.semanticHash ? (a.semanticHash === b.semanticHash ? 1 : 0) : null, 0.38, 'semantic', a.semanticHash === b.semanticHash);
  add(evidence, 'cfg-shape', cfgSimilarity(a.cfg, b.cfg), 0.12, 'cfg');
  add(evidence, 'basic-blocks', jaccard(a.basicBlockHashes, b.basicBlockHashes), 0.08, 'cfg');
  add(evidence, 'strings', jaccard(a.strings, b.strings), 0.06, 'context');
  add(evidence, 'imports', jaccard(a.imports, b.imports), 0.06, 'context');
  add(evidence, 'calls', jaccard(a.calls, b.calls), 0.05, 'context');
  add(evidence, 'constants', jaccard(a.constants, b.constants), 0.05, 'context');
  add(evidence, 'field-shape', jaccard(a.fieldAccessShape, b.fieldAccessShape), 0.06, 'semantic-context');
  add(evidence, 'objc-profile', jaccard(profileBag(a.objc), profileBag(b.objc)), 0.08, 'runtime');
  add(evidence, 'swift-profile', jaccard(profileBag(a.swift), profileBag(b.swift)), 0.08, 'runtime');
  add(evidence, 'runtime-metadata', jaccard(a.runtimeMetadata, b.runtimeMetadata), 0.06, 'runtime');
  add(evidence, 'size', ratio(a.size, b.size), 0.04, 'shape');

  const byGroup = new Map();
  for (const e of evidence) {
    if (!byGroup.has(e.group)) byGroup.set(e.group, []);
    byGroup.get(e.group).push(e);
  }
  let weighted = 0, total = 0;
  for (const group of byGroup.values()) {
    for (const e of group) { weighted += e.value * e.weight; total += e.weight; }
  }
  let confidence = total ? weighted / total : 0;
  const strongPositive = evidence.filter((e) => ['bytes','instruction','semantic','cfg'].includes(e.group) && e.value >= 0.9);
  const onlyWeak = strongPositive.length === 0;
  if (onlyWeak) confidence = Math.min(confidence, 0.59);
  if (normalizedExact) confidence = Math.max(confidence, 0.985);
  const semanticExact = evidence.some((e) => e.signal === 'semantic-ir' && e.value === 1);
  if (semanticExact && strongPositive.length >= 2) confidence = Math.max(confidence, 0.9);
  const instructionExact = evidence.some((e) => e.signal === 'instruction-sequence' && e.value === 1);
  if (instructionExact && evidence.some((e) => e.signal === 'normalized-operands' && e.value === 1)) confidence = Math.max(confidence, 0.86);
  confidence = Math.max(0, Math.min(1, confidence));

  let identity = 'unrelated';
  if (normalizedExact) identity = 'normalized-identical';
  else if (semanticExact && confidence >= 0.88) identity = 'semantic-equivalent';
  else if (confidence >= 0.78 && strongPositive.length >= 1) identity = 'probable-same';
  else if (confidence >= 0.55) identity = 'similar';
  const reasons = evidence.filter((e) => e.value >= 0.75).sort((x, y) => y.weight * y.value - x.weight * x.value).map((e) => e.signal);
  return { confidence, identity, reasons, evidence };
}

export function coarseTokens(fp) {
  if (!fp?.schema) fp = fingerprintFunctionFast(fp);
  const out = [];
  if (fp.normalizedBytesHash) out.push('nb:' + fp.normalizedBytesHash);
  if (fp.semanticHash) out.push('sem:' + fp.semanticHash);
  if (fp.instructionSequenceHash) out.push('ins:' + fp.instructionSequenceHash);
  if (fp.instructionBagHash) out.push('ib:' + fp.instructionBagHash);
  if (fp.normalizedOperandsHash) out.push('ops:' + fp.normalizedOperandsHash);
  if (fp.normalizedOperandBagHash) out.push('ob:' + fp.normalizedOperandBagHash);
  if (fp.cfgHash) out.push('cfg:' + fp.cfgHash);
  if (fp.objc?.selector) out.push('objc:' + fp.objc.selector);
  for (const x of (fp.strings || []).slice(0, 2)) out.push('str:' + x);
  for (const x of (fp.imports || []).slice(0, 2)) out.push('imp:' + x);
  if (fp.swift?.typeDescriptor) out.push('swift:' + fp.swift.typeDescriptor);
  if (fp.size > 0) out.push('sz:' + Math.floor(Math.log2(Math.max(1, fp.size))));
  return out;
}
