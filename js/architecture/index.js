import { assemble as assembleArm64 } from '../patch.js';

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
    this.assemble = definition.assemble || null;
    this.controlFlow = definition.controlFlow || (() => null);
    this.callKind = definition.callKind || (() => null);
    this.returnKind = definition.returnKind || (() => null);
    this.rowForAddress = definition.rowForAddress || ((region, address) => {
      if (this.fixedInstructionSize == null || !region) return null;
      const rel = BigInt(address) - BigInt(region.vmAddr);
      if (rel < 0n || rel >= BigInt(region.size)) return null;
      const size = BigInt(this.fixedInstructionSize);
      if (rel % size !== 0n) return null;
      return Number(rel / size);
    });
    this.addressForRow = definition.addressForRow || ((region, row) => {
      if (this.fixedInstructionSize == null || !region) return null;
      const n = Number(row);
      if (!Number.isSafeInteger(n) || n < 0) return null;
      const address = BigInt(region.vmAddr) + BigInt(n) * BigInt(this.fixedInstructionSize);
      return address < BigInt(region.vmAddr) + BigInt(region.size) ? address : null;
    });
    this.validateInstructionPlacement = definition.validateInstructionPlacement || ((region, address, length) => {
      if (this.fixedInstructionSize == null) return unsupportedArchitectureResult('assemble', this.id);
      const rel = BigInt(address) - BigInt(region?.vmAddr ?? 0n);
      if (!region || rel < 0n || rel >= BigInt(region.size)) return { ok:false, code:'patch-range', error:'アドレスがコードのセクション範囲外です。' };
      if (rel % BigInt(this.instructionAlignment) !== 0n || Number(length) !== this.fixedInstructionSize) {
        return { ok:false, code:'instruction-placement', architecture:this.id, error:`${this.id} 命令の位置または長さが不正です。` };
      }
      return { ok:true };
    });
    Object.freeze(this);
  }
}

export class UnsupportedArchitectureError extends Error {
  constructor(operation, architecture) {
    super(`${operation} is not supported for architecture ${architecture || 'unknown'}`);
    this.name = 'UnsupportedArchitectureError';
    this.code = 'unsupported-architecture';
    this.unsupported = true;
    this.operation = operation;
    this.architecture = canonicalId(architecture || 'unknown');
  }
}

export function unsupportedArchitectureResult(operation, architecture) {
  const error = new UnsupportedArchitectureError(operation, architecture);
  return {
    ok:false,
    unsupported:true,
    code:error.code,
    operation:error.operation,
    architecture:error.architecture,
    error:error.message,
  };
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
  assemble: assembleArm64,
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
