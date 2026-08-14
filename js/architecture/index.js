const BUILTINS = new Map();

function canonicalArchitectureId(value) {
  const id=String(value ?? '').trim().toLowerCase();
  if (!id) throw new TypeError('architecture id is required');
  return id;
}

function positiveInteger(value, name, fallback) {
  if (value == null && fallback != null) return fallback;
  const n=Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n<=0) throw new TypeError(`${name} must be a positive integer`);
  return n;
}

function arm64Mnemonic(instruction) { return String(instruction?.mnemonic || '').trim().toLowerCase(); }
function isArm64Return(op) { return /^(ret|retaa|retab)$/.test(op); }
function isArm64AuthenticatedCall(op) { return /^blr(?:aa|ab)z?$/.test(op); }
function isArm64AuthenticatedBranch(op) { return /^br(?:aa|ab)z?$/.test(op); }

export class ArchitectureAdapter {
  constructor(definition) {
    if (!definition?.id) throw new TypeError('architecture id is required');
    this.id = canonicalArchitectureId(definition.id);
    this.instructionAlignment = positiveInteger(definition.instructionAlignment, 'instructionAlignment', 1);
    this.fixedInstructionSize = definition.fixedInstructionSize == null ? null : positiveInteger(definition.fixedInstructionSize, 'fixedInstructionSize');
    this.viewerCompatible = !!definition.viewerCompatible;
    this.decode = definition.decode || null;
    this.controlFlow = definition.controlFlow || (() => null);
    this.callKind = definition.callKind || (() => null);
    this.returnKind = definition.returnKind || (() => null);
    Object.freeze(this);
  }
}

export function registerArchitectureAdapter(definition, { replace = false } = {}) {
  const adapter = definition instanceof ArchitectureAdapter ? definition : new ArchitectureAdapter(definition);
  const id=canonicalArchitectureId(adapter.id);
  if (BUILTINS.has(id) && !replace) throw new Error(`architecture already registered: ${id}`);
  BUILTINS.set(id, adapter);
  return adapter;
}

export function architectureAdapter(id) {
  const key=String(id || '').trim().toLowerCase();
  return BUILTINS.get(key) || BUILTINS.get('unknown');
}

export function architectureCapability(image, engine = {}) {
  const architecture = String(image?.arch || 'unknown').trim().toLowerCase();
  const adapter = architectureAdapter(architecture);
  const engineSupported = !!engine[architecture];
  const arm64Analysis = architecture === 'arm64' && engineSupported;
  const emulationSupported = !!engine.emulation?.[architecture];
  return Object.freeze({
    format: image?.format || 'unknown',
    architecture,
    endianness: image?.endian || 'unknown',
    bits: Number(image?.bits || 0),
    canDisassemble: engineSupported,
    canAnalyzeDataflow: arm64Analysis,
    canEmulate: emulationSupported,
    viewerCanDisassemble: engineSupported && !!adapter.viewerCompatible,
    instructionAlignment: adapter.instructionAlignment,
    fixedInstructionSize: adapter.fixedInstructionSize,
    engineVerified: !!engine.verified,
  });
}

registerArchitectureAdapter({
  id: 'arm64', instructionAlignment: 4, fixedInstructionSize: 4, viewerCompatible: true,
  controlFlow(instruction) {
    const op = arm64Mnemonic(instruction);
    if (isArm64Return(op)) return 'return';
    if (op === 'bl' || op === 'blr' || isArm64AuthenticatedCall(op)) return 'call';
    if (op === 'b' || op === 'br' || isArm64AuthenticatedBranch(op)) return 'branch';
    if (op.startsWith('b.') || op === 'cbz' || op === 'cbnz' || op === 'tbz' || op === 'tbnz') return 'conditional-branch';
    return 'fallthrough';
  },
  callKind(instruction) { const op=arm64Mnemonic(instruction); return op==='bl'||op==='blr'||isArm64AuthenticatedCall(op) ? 'call' : null; },
  returnKind(instruction) { return isArm64Return(arm64Mnemonic(instruction)) ? 'return' : null; },
});

registerArchitectureAdapter({
  id: 'x86_64', instructionAlignment: 1, fixedInstructionSize: null, viewerCompatible: false,
  controlFlow(instruction) {
    const op = String(instruction?.mnemonic || '').toLowerCase();
    if (op.startsWith('ret')) return 'return';
    if (op === 'call') return 'call';
    if (op === 'jmp') return 'branch';
    if (/^j[^m]/.test(op)) return 'conditional-branch';
    return 'fallthrough';
  },
  callKind(instruction) { return /^call$/i.test(instruction?.mnemonic || '') ? 'call' : null; },
  returnKind(instruction) { return /^ret/.test(String(instruction?.mnemonic || '').toLowerCase()) ? 'return' : null; },
});

registerArchitectureAdapter({ id: 'unknown', instructionAlignment: 1, fixedInstructionSize: null, viewerCompatible: false });
