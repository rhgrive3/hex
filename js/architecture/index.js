const BUILTINS = new Map();

function canonicalId(value) { return String(value || '').trim().toLowerCase(); }
function positiveInteger(value, name, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) throw new TypeError(`${name} must be a finite positive integer`);
  return n;
}

export class ArchitectureAdapter {
  constructor(definition) {
    const id = canonicalId(definition?.id);
    if (!id) throw new TypeError('architecture id is required');
    this.id = id;
    this.instructionAlignment = positiveInteger(definition.instructionAlignment ?? 1, 'instructionAlignment');
    this.fixedInstructionSize = positiveInteger(definition.fixedInstructionSize, 'fixedInstructionSize', { nullable: true });
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
  const id = canonicalId(adapter.id);
  if (BUILTINS.has(id) && !replace) throw new Error(`architecture already registered: ${id}`);
  BUILTINS.set(id, adapter);
  return adapter;
}

export function architectureAdapter(id) { return BUILTINS.get(canonicalId(id)) || BUILTINS.get('unknown'); }

export function architectureCapability(image, engine = {}) {
  const architecture = canonicalId(image?.arch || 'unknown');
  const adapter = architectureAdapter(architecture);
  const engineSupported = !!engine[architecture];
  const arm64Analysis = architecture === 'arm64' && engineSupported;
  const emulationSupported = !!engine.emulation?.[architecture];
  return Object.freeze({
    format: image?.format || 'unknown', architecture, endianness: image?.endian || 'unknown', bits: Number(image?.bits || 0),
    canDisassemble: engineSupported, canAnalyzeDataflow: arm64Analysis, canEmulate: emulationSupported,
    viewerCanDisassemble: engineSupported && !!adapter.viewerCompatible,
    instructionAlignment: adapter.instructionAlignment, fixedInstructionSize: adapter.fixedInstructionSize, engineVerified: !!engine.verified,
  });
}

registerArchitectureAdapter({
  id: 'arm64', instructionAlignment: 4, fixedInstructionSize: 4, viewerCompatible: true,
  controlFlow(instruction) {
    const op = String(instruction?.mnemonic || '').toLowerCase();
    if (/^ret(?:aa|ab)?$/.test(op)) return 'return';
    if (/^(?:bl|blr|blraa|blrab|blraaz|blrabz)$/.test(op)) return 'call';
    if (/^(?:b|br|braa|brab|braaz|brabz)$/.test(op)) return 'branch';
    if (op.startsWith('b.') || op === 'cbz' || op === 'cbnz' || op === 'tbz' || op === 'tbnz') return 'conditional-branch';
    return 'fallthrough';
  },
  callKind(instruction) { return /^(?:bl|blr|blraa|blrab|blraaz|blrabz)$/i.test(instruction?.mnemonic || '') ? 'call' : null; },
  returnKind(instruction) { return /^ret(?:aa|ab)?$/i.test(instruction?.mnemonic || '') ? 'return' : null; },
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
