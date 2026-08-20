import {
  architecturePluginV2,
  architecturePluginsV2,
  ArchitecturePluginV2,
} from '../targets/architecture/index.js';

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
      const size = BigInt(this.fixedInstructionSize);
      if (rel < 0n || rel + size > BigInt(region.size)) return null;
      if (rel % size !== 0n) return null;
      return Number(rel / size);
    });
    this.addressForRow = definition.addressForRow || ((region, row) => {
      if (this.fixedInstructionSize == null || !region) return null;
      const n = Number(row);
      if (!Number.isSafeInteger(n) || n < 0) return null;
      const size = BigInt(this.fixedInstructionSize);
      const address = BigInt(region.vmAddr) + BigInt(n) * size;
      return address + size <= BigInt(region.vmAddr) + BigInt(region.size) ? address : null;
    });
    this.validateInstructionPlacement = definition.validateInstructionPlacement || ((region, address, length) => {
      if (this.fixedInstructionSize == null) return unsupportedArchitectureResult('assemble', this.id);
      if (!region) return { ok:false, code:'patch-range', error:'アドレスがコードのセクション範囲外です。' };
      const rel = BigInt(address) - BigInt(region.vmAddr);
      const size = BigInt(this.fixedInstructionSize);
      if (rel < 0n || rel + size > BigInt(region.size)) return { ok:false, code:'patch-range', error:'アドレスがコードのセクション範囲外です。' };
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
  const target = architecturePluginV2(architecture);
  const engineSupported = !!engine[architecture] || (architecture === 'arm64e' && !!engine.arm64);
  const legacyArm64Analysis = (architecture === 'arm64' || architecture === 'arm64e') && engineSupported;
  const semanticCapability = target?.capabilities?.semanticAnalysis || 'unsupported';
  const arm64Analysis = legacyArm64Analysis && semanticCapability !== 'unsupported';
  const emulationSupported = !!engine.emulation?.[architecture];
  const analysisLevel = arm64Analysis ? (architecture === 'arm64e' ? 'partial' : 'full') : 'unsupported';
  return Object.freeze({
    format: image?.format || 'unknown', architecture, endianness: image?.endian || 'unknown', bits: Number(image?.bits || 0),
    canDisassemble: engineSupported, canAnalyzeDataflow: arm64Analysis, canEmulate: emulationSupported,
    viewerCanDisassemble: engineSupported && !!adapter.viewerCompatible,
    instructionAlignment: adapter.instructionAlignment, fixedInstructionSize: adapter.fixedInstructionSize, engineVerified: !!engine.verified,
    analysisLevel, partial: analysisLevel === 'partial',
    limitations: architecture === 'arm64e' ? Object.freeze(['pointer-authentication data semantics are conservative']) : Object.freeze([]),
  });
}

function legacyDefinition(plugin) {
  const controlFlow = (instruction) => plugin.classifyControlFlow(instruction);
  return {
    id:plugin.id,
    instructionAlignment:plugin.instructionAlignment,
    fixedInstructionSize:plugin.fixedInstructionSize,
    viewerCompatible:plugin.viewerCompatible,
    decode:plugin.decode,
    assemble:plugin.assemble,
    controlFlow,
    callKind(instruction) { return controlFlow(instruction) === 'call' ? 'call' : null; },
    returnKind(instruction) { return controlFlow(instruction) === 'return' ? 'return' : null; },
  };
}

for (const plugin of architecturePluginsV2()) registerArchitectureAdapter(legacyDefinition(plugin));

export { ArchitecturePluginV2, architecturePluginV2, architecturePluginsV2 };
