const ARCHITECTURES = new Map();

function canonicalId(value) { return String(value || '').trim().toLowerCase(); }
function positiveInteger(value, name, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) throw new TypeError(`${name} must be a finite positive integer`);
  return n;
}

export class ArchitecturePluginV2 {
  constructor(definition = {}) {
    const id = canonicalId(definition.id);
    if (!id) throw new TypeError('architecture id is required');
    this.id = id;
    this.semanticVersion = String(definition.semanticVersion || '1');
    this.modes = definition.modes || (() => Object.freeze([]));
    this.registerFile = definition.registerFile || (() => Object.freeze([]));
    this.physicalAddressSpaces = definition.physicalAddressSpaces || (() => Object.freeze(['register','memory','code','unique']));
    this.decode = definition.decode || null;
    this.decodeProvider = definition.decodeProvider || null;
    this.liftExact = definition.liftExact || null;
    this.classifyControlFlow = definition.classifyControlFlow || (() => null);
    this.assemble = definition.assemble || null;
    this.validateEncoding = definition.validateEncoding || null;
    this.instructionAlignment = positiveInteger(definition.instructionAlignment ?? 1, 'instructionAlignment');
    this.fixedInstructionSize = positiveInteger(definition.fixedInstructionSize, 'fixedInstructionSize', { nullable:true });
    this.viewerCompatible = !!definition.viewerCompatible;
    this.capabilities = Object.freeze({
      decode: definition.capabilities?.decode || (this.decode ? 'native' : this.decodeProvider ? 'external' : 'unsupported'),
      exactEffects: definition.capabilities?.exactEffects || (this.liftExact ? 'available' : 'unsupported'),
      semanticAnalysis: definition.capabilities?.semanticAnalysis || 'unsupported',
    });
    Object.freeze(this);
  }
}

export function registerArchitecturePlugin(definition, { replace = false } = {}) {
  const plugin = definition instanceof ArchitecturePluginV2 ? definition : new ArchitecturePluginV2(definition);
  if (ARCHITECTURES.has(plugin.id) && !replace) throw new Error(`architecture already registered: ${plugin.id}`);
  ARCHITECTURES.set(plugin.id, plugin);
  return plugin;
}

export function architecturePluginV2(id) {
  return ARCHITECTURES.get(canonicalId(id)) || ARCHITECTURES.get('unknown') || null;
}

export function architecturePluginsV2() { return Object.freeze(Array.from(ARCHITECTURES.values())); }
