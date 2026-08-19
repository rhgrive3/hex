const ABI_PLUGINS = new Map();

function canonicalId(value) { return String(value || '').trim().toLowerCase(); }
function frozenArray(value) { return Object.freeze(Array.isArray(value) ? value.slice() : []); }

export class ABIPlugin {
  constructor(definition = {}) {
    const id = canonicalId(definition.id);
    if (!id) throw new TypeError('ABI id is required');
    const architectureId = canonicalId(definition.architectureId);
    if (!architectureId) throw new TypeError(`ABI ${id} architectureId is required`);

    this.id = id;
    this.semanticVersion = String(definition.semanticVersion || '1');
    this.architectureId = architectureId;
    this.platformPredicate = typeof definition.platformPredicate === 'function'
      ? definition.platformPredicate
      : (() => true);
    this.callingConventions = definition.callingConventions || (() => frozenArray([]));
    this.classifyArguments = definition.classifyArguments || (() => ({
      srcs: [], arguments: [], stackArguments: [], stackArgsUnknown: true,
      stackArgsMayContainPointers: true, evidence: 'unsupported-abi', unsupported: true,
    }));
    this.classifyCallReturn = definition.classifyCallReturn || (() => null);
    this.classifyFunctionReturn = definition.classifyFunctionReturn || (() => null);
    this.classifyEntryRegister = definition.classifyEntryRegister || (() => ({ kind:'incoming-register-state' }));
    this.callerSaved = definition.callerSaved || (() => frozenArray([]));
    this.calleeSaved = definition.calleeSaved || (() => frozenArray([]));
    this.stackRules = definition.stackRules || (() => Object.freeze({ unknown:true }));
    this.redZone = definition.redZone || (() => null);
    this.syscallABI = definition.syscallABI || null;
    this.unwindRules = definition.unwindRules || (() => Object.freeze({ unknown:true }));
    this.defaultUnknownCallEffects = definition.defaultUnknownCallEffects || (() => Object.freeze({
      registerEffects:'unknown', memoryEffects:'unknown', mayThrow:true,
    }));
    this.supported = definition.supported !== false;
    Object.freeze(this);
  }
}

export function registerABIPlugin(definition, { replace = false } = {}) {
  const plugin = definition instanceof ABIPlugin ? definition : new ABIPlugin(definition);
  if (ABI_PLUGINS.has(plugin.id) && !replace) throw new Error(`ABI already registered: ${plugin.id}`);
  ABI_PLUGINS.set(plugin.id, plugin);
  return plugin;
}

export function abiPlugin(id) {
  return ABI_PLUGINS.get(canonicalId(id)) || ABI_PLUGINS.get('unknown') || null;
}

export function abiPlugins() { return Object.freeze(Array.from(ABI_PLUGINS.values())); }

export function findABIPlugin({ id = null, architecture = null, platform = null } = {}) {
  if (id) return abiPlugin(id);
  const arch = canonicalId(architecture);
  const platformId = canonicalId(platform);
  for (const plugin of ABI_PLUGINS.values()) {
    if (!plugin.supported || plugin.id === 'unknown') continue;
    if (arch && plugin.architectureId !== arch && !(arch === 'arm64e' && plugin.architectureId === 'arm64')) continue;
    let matches = false;
    try { matches = plugin.platformPredicate({ architecture:arch, platform:platformId }); } catch { matches = false; }
    if (matches) return plugin;
  }
  return abiPlugin('unknown');
}
