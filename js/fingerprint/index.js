import { parseOperands } from '../arm64.js';

const MASK64 = 0xffffffffffffffffn;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
export const FUNCTION_FINGERPRINT_VERSION = 4;

export class FingerprintVersionError extends Error {
  constructor(version, schema) {
    super(`unsupported ${schema || 'fingerprint'} version: ${version}; current version is ${FUNCTION_FINGERPRINT_VERSION}`);
    this.name = 'FingerprintVersionError';
    this.code = 'unsupported-fingerprint-version';
    this.version = version;
    this.schema = schema || null;
  }
}

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

function fingerprintSchema(value) {
  return value?.schema === 'hex.function-fingerprint' || value?.schema === 'hex.function-fingerprint-fast' ? value.schema : null;
}

export function assertFingerprintCompatible(value) {
  const schema = fingerprintSchema(value);
  if (!schema) return value;
  const version = Number(value.version);
  if (!Number.isSafeInteger(version) || version < 1) throw new FingerprintVersionError(value.version, schema);
  if (version > FUNCTION_FINGERPRINT_VERSION) throw new FingerprintVersionError(version, schema);
  return value;
}

const IGNORABLE_MNEMONICS = new Set(['nop', 'bti', 'paciasp', 'pacibsp', 'autiasp', 'autibsp', 'xpaclri']);
const BRANCH_MNEMONICS = /^(b(\.|$)|bl$|blr$|cbn?z$|tbn?z$)/;
const ADDRESS_MNEMONICS = /^(adrp?|ldr|str|ldp|stp)$/;
const REGEX_REG = /\b([xwvsdqhb])(\d{1,2})\b/gi;

function registerFamily(cls) { return /^[xw]$/i.test(cls) ? 'gpr' : 'vec'; }
function normalizeRegisters(text, options = {}) {
  const registerMap = options.registerMap instanceof Map ? options.registerMap : new Map();
  const registerCounters = options.registerCounters instanceof Map ? options.registerCounters : new Map();
  return text.replace(REGEX_REG, (_m, cls, number) => {
    const family = registerFamily(cls), key = `${family}:${number}`;
    let id = registerMap.get(key);
    if (id == null) {
      id = registerCounters.get(family) || 0;
      registerCounters.set(family, id + 1);
      registerMap.set(key, id);
    }
    return `${cls.toLowerCase()}R${id}`;
  });
}

function canonicalRegister(op, options) {
  if (!op) return '?';
  const text = String(op.text || '').toLowerCase();
  if (text === 'fp' || text === 'x29') return 'FP';
  if (text === 'lr' || text === 'x30') return 'LR';
  if (text === 'sp' || text === 'wsp') return 'SP';
  if (text === 'xzr' || text === 'wzr') return text.toUpperCase();
  return normalizeRegisters(text, options);
}

function numericOther(op) {
  const text = String(op?.text || '').trim();
  if (!/^[#]?[+-]?(?:0[xX][0-9a-fA-F]+|\d+)$/.test(text)) return null;
  const stripped = text.replace(/^#/, '');
  const sign = stripped[0] === '-' || stripped[0] === '+' ? stripped[0] : '';
  const body = sign ? stripped.slice(1) : stripped;
  try {
    const value = BigInt(body);
    return sign === '-' ? -value : value;
  } catch { return null; }
}

function canonicalImmediate(op) {
  if (op?.float != null) return String(op.float);
  const value = op?.value != null ? BigInt(op.value) : numericOther(op);
  return value == null ? String(op?.text || '') : '#' + value.toString(10);
}

function canonicalShift(shift) {
  if (!shift || !shift.op) return '';
  return shift.amount == null ? shift.op : `${shift.op} #${Number(shift.amount)}`;
}

function canonicalMem(op, options) {
  const base = canonicalRegister(op.base, options);
  if ((base === 'SP' || base === 'FP') && op.disp) return `[${base},@stack]${op.mode === 'pre' ? '!' : op.mode === 'post' ? ',@post' : ''}`;
  const parts = [base];
  if (op.index) parts.push(canonicalRegister(op.index, options));
  if (op.disp) parts.push(canonicalImmediate(op.disp));
  if (op.shift) parts.push(canonicalShift(op.shift));
  let text = '[' + parts.join(',') + ']';
  if (op.mode === 'pre') text += '!';
  else if (op.mode === 'post') text += ',@post';
  return text;
}

function canonicalOperand(op, mnemonic, index, options) {
  const isBranchTarget = BRANCH_MNEMONICS.test(mnemonic) && index === (mnemonic.startsWith('cb') ? 1 : mnemonic.startsWith('tb') ? 2 : 0);
  const isAddressValue = /^adrp?$/.test(mnemonic) && index === 1;
  const rawNumeric = op?.k === 'imm' ? op.value : numericOther(op);
  if ((isBranchTarget || isAddressValue) && rawNumeric != null) return isBranchTarget ? '@branch' : '@address';
  if (ADDRESS_MNEMONICS.test(mnemonic) && op?.k !== 'mem' && rawNumeric != null && BigInt(rawNumeric < 0n ? -rawNumeric : rawNumeric) >= 0x1000n) return '@address';
  if (op?.k === 'reg') return canonicalRegister(op, options) + (op.shift ? ',' + canonicalShift(op.shift) : '');
  if (op?.k === 'imm') return canonicalImmediate(op) + (op.shift ? ',' + canonicalShift(op.shift) : '');
  if (op?.k === 'mem') return canonicalMem(op, options);
  if (op?.k === 'cond') return String(op.text || '').toLowerCase();
  if (op?.k === 'list') return '{' + (op.regs || []).map((r) => canonicalOperand(r, mnemonic, index, options)).join(',') + '}';
  if (op?.k === 'elem') return String(op.text || '').toLowerCase();
  const text = String(op?.text || '').replace(/\b(fp|x29)\b/gi, 'FP').replace(/\b(lr|x30)\b/gi, 'LR').replace(/\bsp\b/gi, 'SP');
  return normalizeRegisters(text, options);
}

function normalizeInstructionList(instructions = [], options = {}) {
  const shared = { ...options, registerMap:new Map(), registerCounters:new Map() };
  return instructions.map((x) => normalizeInstruction(x, shared)).filter(Boolean);
}
function normalizeInstructionBag(instructions = [], options = {}) {
  return instructions.map((x) => normalizeInstruction(x, { ...options, registerMap:new Map(), registerCounters:new Map() })).filter(Boolean);
}

export function normalizeInstruction(instruction, options = {}) {
  let mnemonic, operandText, structured = null;
  if (typeof instruction === 'string') {
    const m = /^\s*([a-z0-9.]+)\s*(.*)$/i.exec(instruction);
    mnemonic = (m?.[1] || '').toLowerCase();
    operandText = m?.[2] || '';
  } else {
    mnemonic = String(instruction?.mnemonic || instruction?.op || '').toLowerCase();
    if (Array.isArray(instruction?.parsedOperands)) structured = instruction.parsedOperands;
    operandText = typeof instruction?.operands === 'string' ? instruction.operands : String(instruction?.opStr ?? '');
  }
  if (!mnemonic) return null;
  if (options.ignoreCompilerNoise !== false && IGNORABLE_MNEMONICS.has(mnemonic)) return null;
  const parsed = structured || parseOperands(operandText);
  const normalizedOperands = parsed.map((op, index) => canonicalOperand(op, mnemonic, index, options));
  // Stack-frame size is compiler layout noise, not function identity. Preserve
  // the v3 contract when using the v4 structured-operand canonicalizer.
  if (/^(add|sub)$/.test(mnemonic) && normalizedOperands[0] === 'SP' && normalizedOperands[1] === 'SP' &&
      parsed[2] && (parsed[2].k === 'imm' || numericOther(parsed[2]) != null)) normalizedOperands[2] = '@frame';
  const normalized = normalizedOperands.join(', ');
  return { mnemonic, operands: normalized.replace(/\s+/g, ' ').trim() };
}

function inferredRelocationWidth(raw, architecture = 'unknown') {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.width != null || raw.size != null) {
    const width = Number(raw.width ?? raw.size);
    return Number.isSafeInteger(width) && width > 0 && width <= 16 ? width : null;
  }
  const length = raw.length ?? raw.r_length;
  if (length != null) {
    const n = Number(length);
    if (Number.isSafeInteger(n) && n >= 0 && n <= 4) return 1 << n;
  }
  const arch = String(raw.architecture || raw.arch || architecture || '').toLowerCase();
  const type = String(raw.type || raw.relocationType || raw.kind || '').toLowerCase();
  if (/arm64|aarch64/.test(arch)) {
    if (/branch26|page21|pageoff12|got_load_page|got_load_pageoff|pointer_to_got|tlvp_load_page|tlvp_load_pageoff|addend/.test(type)) return 4;
    if (/unsigned|authenticated_pointer|pointer64|abs64/.test(type)) return 8;
  }
  if (/x86_64|amd64/.test(arch)) {
    if (/branch|signed|got|subtractor/.test(type)) return 4;
    if (/unsigned|pointer64|abs64/.test(type)) return 8;
  }
  if (/arm|thumb/.test(arch) && /branch|vanilla|sectdiff/.test(type)) return 4;
  return null;
}

function normalizeRelocationsDetailed(bytes, relocationOffsets = [], relocationRanges = [], architecture = 'unknown') {
  if (!bytes || !bytes.length) return { bytes:null, unknown:[], masked:[] };
  const out = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
  const ranges = [];
  for (const raw of relocationOffsets || []) ranges.push(typeof raw === 'object' ? raw : { offset:raw });
  for (const raw of relocationRanges || []) ranges.push(raw || {});
  const unknown = [], masked = [];
  for (const raw of ranges) {
    const offset = Number(raw.offset);
    const width = inferredRelocationWidth(raw, architecture);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= out.length) continue;
    if (!Number.isSafeInteger(width) || width <= 0) { unknown.push({ offset, type:raw.type || raw.relocationType || null }); continue; }
    const end = Math.min(out.length, offset + width);
    out.fill(0, offset, end);
    masked.push({ offset, width:end - offset });
  }
  return { bytes:out, unknown, masked };
}

export function normalizeRelocations(bytes, relocationOffsets = [], relocationRanges = [], architecture = 'unknown') {
  return normalizeRelocationsDetailed(bytes, relocationOffsets, relocationRanges, architecture).bytes;
}

function stratifiedByteSample(bytes, maxBytes = 256) {
  if (!bytes?.length) return [];
  if (bytes.length <= maxBytes) return Array.from(bytes);
  const first = Math.floor(maxBytes / 3), middle = Math.floor(maxBytes / 3), last = maxBytes - first - middle;
  const middleStart = Math.max(first, Math.floor((bytes.length - middle) / 2));
  const endStart = bytes.length - last;
  return [...bytes.subarray(0, first), ...bytes.subarray(middleStart, middleStart + middle), ...bytes.subarray(endStart)];
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
    const instructions = normalizeInstructionList(block.instructions || block.insns || []);
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
  assertFingerprintCompatible(fn);
  if (fn?.schema === 'hex.function-fingerprint' && fn.version === FUNCTION_FINGERPRINT_VERSION && options.includeSemantic !== false) return fn;
  const bytes = fn.bytes == null ? null : (fn.bytes instanceof Uint8Array ? fn.bytes : new Uint8Array(fn.bytes));
  const architecture = String(fn.architecture || fn.arch || 'unknown').toLowerCase();
  const relocation = normalizeRelocationsDetailed(bytes, fn.relocationOffsets, fn.relocationRanges, architecture);
  const normalizedBytes = relocation.bytes;
  const instructions = normalizeInstructionList(fn.instructions || [], fn.normalization);
  const mnemonics = instructions.map((x) => x.mnemonic);
  const operands = instructions.map((x) => `${x.mnemonic} ${x.operands}`.trim());
  const bagOperands = normalizeInstructionBag(fn.instructions || [], fn.normalization).map((x) => `${x.mnemonic} ${x.operands}`.trim());
  const cfg = cfgShape(fn.cfg);
  const blocks = blockHashes(fn.cfg);
  const semantic = options.includeSemantic === false ? semanticShape({}) : semanticShape(fn);
  const strings = uniq(fn.strings), imports = uniq(fn.imports), calls = uniq(fn.calls), callees = uniq(fn.callees), callers = uniq(fn.callers);
  const constants = numericUniq(fn.constants), fields = uniq([...(fn.fieldAccessShape || []), ...(semantic.fieldShape || [])]), selectors = uniq(fn.objcSelectors ?? fn.selectors), swiftMetadata = uniq(fn.swiftMetadata);
  const runtimeMetadata = uniq(fn.runtimeMetadata), stack = stackShape(fn);
  const objc = { class: fn.objcClass || fn.objc?.class || null, selector: fn.objcSelector || fn.objc?.selector || null, methodKind: fn.objcMethodKind || fn.objc?.methodKind || null, selectors: uniq([...(selectors || []), ...(fn.objc?.selectors || [])]), ivars: uniq(fn.objcIvars || fn.objc?.ivars), protocols: uniq(fn.objcProtocols || fn.objc?.protocols), categories: uniq(fn.objcCategories || fn.objc?.categories), messageSendProfile: uniq(fn.objcMessageSendProfile || fn.messageSendProfile || fn.objc?.messageSendProfile) };
  const swift = { typeDescriptor: fn.swiftTypeDescriptor || fn.swift?.typeDescriptor || null, conformances: uniq(fn.swiftConformances || fn.swift?.conformances), witnessUsage: uniq(fn.swiftWitnessUsage || fn.swift?.witnessUsage), vtableUsage: uniq(fn.swiftVtableUsage || fn.swift?.vtableUsage), metadataAccessors: uniq(fn.swiftMetadataAccessors || fn.swift?.metadataAccessors), runtimeCalls: uniq(fn.swiftRuntimeCalls || fn.swift?.runtimeCalls), metadata: uniq([...(swiftMetadata || []), ...(fn.swift?.metadata || [])]) };
  const size = Math.max(0, Number(fn.size ?? bytes?.length ?? 0));
  const exactBytesHash = bytes?.length ? hashBytes(bytes) : (fn.exactBytesHash || fn.byteHash || null);
  const normalizedBytesHash = normalizedBytes?.length ? hashBytes(normalizedBytes) : (fn.normalizedBytesHash || fn.normalizedByteHash || null);
  const instructionSequenceHash = mnemonics.length ? nonEmptyHash(mnemonics) : (fn.instructionSequenceHash || null);
  const instructionBagHash = mnemonics.length ? nonEmptyHash([...mnemonics].sort()) : (fn.instructionBagHash || null);
  const normalizedOperandsHash = operands.length ? nonEmptyHash(operands) : (fn.normalizedOperandsHash || null);
  const normalizedOperandBagHash = bagOperands.length ? nonEmptyHash([...bagOperands].sort()) : (fn.normalizedOperandBagHash || null);
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
  const relocationNormalization = Object.freeze({
    confidence: relocation.unknown.length ? 0.65 : 1,
    masked: relocation.masked.length,
    unknown: relocation.unknown.length,
  });
  return Object.freeze({
    schema: 'hex.function-fingerprint', version: FUNCTION_FINGERPRINT_VERSION,
    address: fn.address == null ? null : BigInt(fn.address), name: fn.name || null, architecture, size,
    exactBytesHash, byteHash: exactBytesHash, normalizedBytesHash, normalizedByteHash: normalizedBytesHash,
    byteSample: normalizedBytes ? stratifiedByteSample(normalizedBytes) : Array.from(fn.byteSample || []),
    instructionSequenceHash, instructionBagHash, normalizedOperandsHash, normalizedOperandBagHash, cfgHash, basicBlockHashes: blocks, semanticHash, irHash: semanticHash,
    cfg, semantic, constants, strings, imports, calls, callees, callers, fieldAccessShape: fields, stackShape: stack,
    runtimeMetadata, objc, swift, relocationNormalization,
    hash,
  });
}

export function fingerprintFunctionFast(fn = {}) {
  assertFingerprintCompatible(fn);
  if (fn?.schema === 'hex.function-fingerprint-fast' && fn.version === FUNCTION_FINGERPRINT_VERSION) return fn;
  const source = fn?.schema === 'hex.function-fingerprint' ? fingerprintFunction(fn) : null;
  if (source) {
    return Object.freeze({ schema:'hex.function-fingerprint-fast', version:FUNCTION_FINGERPRINT_VERSION, address:source.address, name:source.name, architecture:source.architecture, size:source.size,
      exactBytesHash:source.exactBytesHash, byteHash:source.byteHash, normalizedBytesHash:source.normalizedBytesHash, normalizedByteHash:source.normalizedByteHash,
      instructionSequenceHash:source.instructionSequenceHash, instructionBagHash:source.instructionBagHash, normalizedOperandsHash:source.normalizedOperandsHash, normalizedOperandBagHash:source.normalizedOperandBagHash,
      cfgHash:source.cfgHash, cfg:source.cfg, strings:(source.strings||[]).slice(0,4), imports:(source.imports||[]).slice(0,4), semanticHash:source.semanticHash || null,
      relocationNormalization:source.relocationNormalization,
      objc:{ selector:source.objc?.selector || null }, swift:{ typeDescriptor:source.swift?.typeDescriptor || null } });
  }
  const bytes = fn.bytes == null ? null : (fn.bytes instanceof Uint8Array ? fn.bytes : new Uint8Array(fn.bytes));
  const architecture = String(fn.architecture || fn.arch || 'unknown').toLowerCase();
  const relocation = normalizeRelocationsDetailed(bytes, fn.relocationOffsets, fn.relocationRanges, architecture);
  const normalizedBytes = relocation.bytes;
  const instructions = normalizeInstructionList(fn.instructions || [], fn.normalization);
  const mnemonics = instructions.map((x) => x.mnemonic), operands = instructions.map((x) => `${x.mnemonic} ${x.operands}`.trim());
  const bagOperands = normalizeInstructionBag(fn.instructions || [], fn.normalization).map((x) => `${x.mnemonic} ${x.operands}`.trim());
  const cfg = cfgShape(fn.cfg), blocks = blockHashes(fn.cfg);
  const size = Math.max(0, Number(fn.size ?? bytes?.length ?? 0));
  const exactBytesHash = bytes?.length ? hashBytes(bytes) : (fn.exactBytesHash || fn.byteHash || null);
  const normalizedBytesHash = normalizedBytes?.length ? hashBytes(normalizedBytes) : (fn.normalizedBytesHash || fn.normalizedByteHash || null);
  const instructionSequenceHash = mnemonics.length ? nonEmptyHash(mnemonics) : (fn.instructionSequenceHash || null);
  const instructionBagHash = mnemonics.length ? nonEmptyHash([...mnemonics].sort()) : (fn.instructionBagHash || null);
  const normalizedOperandsHash = operands.length ? nonEmptyHash(operands) : (fn.normalizedOperandsHash || null);
  const normalizedOperandBagHash = bagOperands.length ? nonEmptyHash([...bagOperands].sort()) : (fn.normalizedOperandBagHash || null);
  const cfgHash = (cfg.blocks || cfg.edges || cfg.exits || cfg.loops || cfg.calls) ? nonEmptyHash({cfg,blocks}) : (fn.cfgHash || null);
  return Object.freeze({ schema:'hex.function-fingerprint-fast', version:FUNCTION_FINGERPRINT_VERSION,
    address:fn.address==null?null:BigInt(fn.address), name:fn.name||null, architecture, size, exactBytesHash, byteHash:exactBytesHash, normalizedBytesHash, normalizedByteHash:normalizedBytesHash,
    instructionSequenceHash, instructionBagHash, normalizedOperandsHash, normalizedOperandBagHash, cfgHash, cfg,
    strings:uniq(fn.strings).slice(0,4), imports:uniq(fn.imports).slice(0,4), semanticHash:null,
    relocationNormalization:Object.freeze({ confidence:relocation.unknown.length ? 0.65 : 1, masked:relocation.masked.length, unknown:relocation.unknown.length }),
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
  if (a.exactBytesHash && b.exactBytesHash && a.size > 0 && a.size === b.size && a.exactBytesHash === b.exactBytesHash) {
    return { confidence: 1, identity: 'exact', reasons: ['exact-bytes'], evidence: [{ signal: 'exact-bytes', value: 1, weight: 1, group: 'bytes', exact: true }] };
  }
  const evidence = [];
  const relocationConfidence = Math.min(a.relocationNormalization?.confidence ?? 1, b.relocationNormalization?.confidence ?? 1);
  const normalizedExact = !!a.normalizedBytesHash && a.normalizedBytesHash === b.normalizedBytesHash && a.size > 0 && a.size === b.size;
  add(evidence, 'normalized-bytes', normalizedExact ? relocationConfidence : null, 0.46, 'bytes', normalizedExact && relocationConfidence === 1);
  if (!normalizedExact) add(evidence, 'byte-similarity', byteSampleSimilarity(a.byteSample, b.byteSample), 0.16, 'byte-sample');
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
    const groupWeight = Math.max(...group.map((e) => e.weight));
    const signalWeight = group.reduce((sum, e) => sum + e.weight, 0);
    const groupValue = signalWeight ? group.reduce((sum, e) => sum + e.value * e.weight, 0) / signalWeight : 0;
    weighted += groupValue * groupWeight; total += groupWeight;
  }
  let confidence = total ? weighted / total : 0;
  const strongPositiveGroups = new Set(evidence.filter((e) => ['bytes','instruction','semantic','cfg'].includes(e.group) && e.value >= 0.9).map((e) => e.group));
  const onlyWeak = strongPositiveGroups.size === 0;
  if (onlyWeak) confidence = Math.min(confidence, 0.59);
  if (normalizedExact && relocationConfidence === 1) confidence = Math.max(confidence, 0.985);
  const semanticExact = evidence.some((e) => e.signal === 'semantic-ir' && e.value === 1);
  if (semanticExact && strongPositiveGroups.size >= 2) confidence = Math.max(confidence, 0.9);
  const instructionExact = evidence.some((e) => e.signal === 'instruction-sequence' && e.value === 1);
  if (instructionExact && evidence.some((e) => e.signal === 'normalized-operands' && e.value === 1) && strongPositiveGroups.size >= 2) confidence = Math.max(confidence, 0.86);
  if (!normalizedExact && strongPositiveGroups.size < 2) confidence = Math.min(confidence, 0.77);
  if (relocationConfidence < 1 && strongPositiveGroups.size < 2) confidence = Math.min(confidence, 0.7);
  confidence = Math.max(0, Math.min(1, confidence));

  let identity = 'unrelated';
  if (normalizedExact && relocationConfidence === 1) identity = 'normalized-identical';
  else if (semanticExact && strongPositiveGroups.size >= 2 && confidence >= 0.88) identity = 'semantic-equivalent';
  else if (confidence >= 0.78 && strongPositiveGroups.size >= 2) identity = 'probable-same';
  else if (confidence >= 0.55) identity = 'similar';
  const reasons = evidence.filter((e) => e.value >= 0.75).sort((x, y) => y.weight * y.value - x.weight * x.value).map((e) => e.signal);
  return { confidence, identity, reasons, evidence };
}

export function coarseTokens(fp) {
  assertFingerprintCompatible(fp);
  if (!fp?.schema || Number(fp.version || 0) < FUNCTION_FINGERPRINT_VERSION) fp = fingerprintFunctionFast(fp);
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