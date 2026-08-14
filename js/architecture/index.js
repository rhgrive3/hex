const BUILTINS = new Map();

export class ArchitectureAdapter {
  constructor(definition) {
    if (!definition?.id) throw new TypeError('architecture id is required');
    this.id = definition.id;
    this.instructionAlignment = Math.max(1, Number(definition.instructionAlignment || 1));
    this.fixedInstructionSize = definition.fixedInstructionSize == null ? null : Number(definition.fixedInstructionSize);
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
  if (BUILTINS.has(adapter.id) && !replace) throw new Error(`architecture already registered: ${adapter.id}`);
  BUILTINS.set(adapter.id, adapter);
  return adapter;
}

export function architectureAdapter(id) {
  return BUILTINS.get(String(id || '').toLowerCase()) || BUILTINS.get('unknown');
}

export function architectureCapability(image, engine = {}) {
  const architecture = String(image?.arch || 'unknown').toLowerCase();
  const adapter = architectureAdapter(architecture);
  const engineSupported = !!engine[architecture];
  const arm64Analysis = architecture === 'arm64' && engineSupported;
  return Object.freeze({
    format: image?.format || 'unknown',
    architecture,
    endianness: image?.endian || 'unknown',
    bits: Number(image?.bits || 0),
    canDisassemble: engineSupported,
    canAnalyzeDataflow: arm64Analysis,
    canEmulate: arm64Analysis,
    viewerCanDisassemble: engineSupported && !!adapter.viewerCompatible,
    instructionAlignment: adapter.instructionAlignment,
    fixedInstructionSize: adapter.fixedInstructionSize,
    engineVerified: !!engine.verified,
  });
}

registerArchitectureAdapter({
  id: 'arm64', instructionAlignment: 4, fixedInstructionSize: 4, viewerCompatible: true,
  controlFlow(instruction) {
    const op = String(instruction?.mnemonic || '').toLowerCase();
    if (op === 'ret') return 'return';
    if (op === 'bl' || op === 'blr') return 'call';
    if (op === 'b' || op === 'br') return 'branch';
    if (op.startsWith('b.') || op === 'cbz' || op === 'cbnz' || op === 'tbz' || op === 'tbnz') return 'conditional-branch';
    return 'fallthrough';
  },
  callKind(instruction) { return /^(bl|blr)$/i.test(instruction?.mnemonic || '') ? 'call' : null; },
  returnKind(instruction) { return /^ret$/i.test(instruction?.mnemonic || '') ? 'return' : null; },
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
