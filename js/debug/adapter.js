export const DEBUG_PROTOCOL_VERSION = 1;
export const BREAKPOINT_KINDS = Object.freeze(['address', 'function', 'conditional', 'memory']);
export const DEBUG_CAPABILITIES = Object.freeze([
  'connect','disconnect','attach','launch','pause','resume','stepInto','stepOver','stepOut',
  'breakpointAddress','breakpointFunction','breakpointConditional','watchpointMemory',
  'readRegisters','writeRegister','readMemory','writeMemory','threads','modules','backtrace',
  'evaluate','traceFunction','traceCall','traceReturn','traceBranch','traceMemoryWrite','traceMemoryRead',
  'objcRuntime','swiftRuntime','cancel','replay'
]);

export class DebugAdapterError extends Error {
  constructor(code, message, details = null) {
    super(message || code);
    this.name = 'DebugAdapterError';
    this.code = code;
    this.details = details;
  }
}

export function asAddress(value, name = 'address') {
  try {
    const out = typeof value === 'bigint' ? value : BigInt(value);
    if (out < 0n) throw new Error('negative');
    return out;
  } catch {
    throw new DebugAdapterError('invalid-address', `${name} must be a non-negative integer`);
  }
}

export function boundedInteger(value, fallback, min, max, name = 'value') {
  const n = value == null ? fallback : Number(value);
  if (!Number.isFinite(n)) throw new DebugAdapterError('invalid-number', `${name} must be finite`);
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function normalizeCapabilities(input = {}) {
  const source = input instanceof Set ? Object.fromEntries([...input].map((k) => [k, true])) : input;
  const out = {};
  for (const key of DEBUG_CAPABILITIES) out[key] = !!source[key];
  return Object.freeze(out);
}

export function normalizeBreakpoint(spec) {
  if (!spec || typeof spec !== 'object') throw new DebugAdapterError('invalid-breakpoint', 'breakpoint must be an object');
  const kind = spec.kind || (spec.address != null ? 'address' : spec.function ? 'function' : null);
  if (!BREAKPOINT_KINDS.includes(kind)) throw new DebugAdapterError('invalid-breakpoint', `unsupported breakpoint kind: ${kind}`);
  const id = String(spec.id || `bp:${kind}:${spec.address ?? spec.function ?? spec.expression ?? ''}`);
  if (kind === 'address') return { id, kind, address: asAddress(spec.address), enabled: spec.enabled !== false };
  if (kind === 'function') {
    const fn = String(spec.function || '').trim();
    if (!fn) throw new DebugAdapterError('invalid-breakpoint', 'function breakpoint requires function');
    return { id, kind, function: fn, address: spec.address == null ? null : asAddress(spec.address), enabled: spec.enabled !== false };
  }
  if (kind === 'conditional') {
    if (spec.address == null) throw new DebugAdapterError('invalid-breakpoint', 'conditional breakpoint requires address');
    const condition = String(spec.condition || '').trim();
    if (!condition) throw new DebugAdapterError('invalid-breakpoint', 'conditional breakpoint requires condition');
    return { id, kind, address: asAddress(spec.address), condition, enabled: spec.enabled !== false };
  }
  const size = boundedInteger(spec.size, 1, 1, 4096, 'watchpoint size');
  return { id, kind: 'memory', address: asAddress(spec.address), size, access: spec.access === 'read' ? 'read' : spec.access === 'readwrite' ? 'readwrite' : 'write', enabled: spec.enabled !== false };
}

const METHOD_CAPABILITY = Object.freeze({
  attach:'attach', launch:'launch', pause:'pause', resume:'resume', stepInto:'stepInto', stepOver:'stepOver', stepOut:'stepOut',
  readRegisters:'readRegisters', writeRegister:'writeRegister', readMemory:'readMemory', writeMemory:'writeMemory',
  getThreads:'threads', getModules:'modules', getBacktrace:'backtrace', evaluate:'evaluate', trace:'traceFunction', watchMemory:'watchpointMemory'
});

export class DebugAdapter {
  constructor({ id, kind = 'generic', capabilities = {} } = {}) {
    this.id = String(id || `${kind}-adapter`);
    this.kind = kind;
    this.capabilities = normalizeCapabilities({ connect: true, disconnect: true, ...capabilities });
    this.connected = false;
  }
  negotiate(requested = null) {
    if (!requested) return this.capabilities;
    const out = {};
    for (const key of requested) out[key] = !!this.capabilities[key];
    return Object.freeze(out);
  }
  require(capability) {
    if (!this.capabilities[capability]) throw new DebugAdapterError('unsupported', `${this.kind} adapter does not support ${capability}`, { capability });
  }
  requireMethod(method) {
    const cap = METHOD_CAPABILITY[method];
    if (cap) this.require(cap);
  }
  async connect() { this.connected = true; return { adapter: this.id, capabilities: this.capabilities }; }
  async disconnect() { this.connected = false; return { disconnected: true }; }
  async attach() { this.require('attach'); }
  async launch() { this.require('launch'); }
  async pause() { this.require('pause'); }
  async resume() { this.require('resume'); }
  async stepInto() { this.require('stepInto'); }
  async stepOver() { this.require('stepOver'); }
  async stepOut() { this.require('stepOut'); }
  async setBreakpoint(spec) {
    const bp = normalizeBreakpoint(spec);
    const cap = bp.kind === 'address' ? 'breakpointAddress' : bp.kind === 'function' ? 'breakpointFunction' : bp.kind === 'conditional' ? 'breakpointConditional' : 'watchpointMemory';
    this.require(cap);
    return bp;
  }
  async removeBreakpoint() { throw new DebugAdapterError('unsupported', 'removeBreakpoint is not implemented'); }
  async readRegisters() { this.require('readRegisters'); }
  async writeRegister() { this.require('writeRegister'); }
  async readMemory() { this.require('readMemory'); }
  async writeMemory() { this.require('writeMemory'); }
  async getThreads() { this.require('threads'); }
  async getModules() { this.require('modules'); }
  async getBacktrace() { this.require('backtrace'); }
  async evaluate() { this.require('evaluate'); }
  async trace() { this.require('traceFunction'); }
  async watchMemory() { this.require('watchpointMemory'); }
}
