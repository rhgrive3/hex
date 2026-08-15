export const DEBUG_PROTOCOL_VERSION = 1;
export const BREAKPOINT_KINDS = Object.freeze(['address', 'function', 'conditional', 'memory']);
export const WATCHPOINT_ACCESS = Object.freeze(['read', 'write', 'readwrite']);
export const DEBUG_CAPABILITIES = Object.freeze([
  'connect','disconnect','attach','launch','pause','resume','stepInto','stepOver','stepOut',
  'breakpointAddress','breakpointFunction','breakpointConditional','watchpointMemory',
  'removeBreakpoint','listBreakpoints',
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
    if (value == null || typeof value === 'boolean') throw new Error('missing');
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) throw new Error('unsafe-number');
      if (value < 0) throw new Error('negative');
      return BigInt(value);
    }
    if (typeof value === 'string' && !value.trim()) throw new Error('empty');
    const out = typeof value === 'bigint' ? value : BigInt(value);
    if (out < 0n) throw new Error('negative');
    return out;
  } catch {
    throw new DebugAdapterError('invalid-address', `${name} must be a non-negative integer`);
  }
}

/** Strict protocol integer validation. UI convenience clamping belongs at the UI boundary. */
export function boundedInteger(value, fallback, min, max, name = 'value') {
  const candidate = value == null ? fallback : value;
  const n = Number(candidate);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new DebugAdapterError('invalid-number', `${name} must be a finite integer`, { name, value });
  }
  if (n < min || n > max) {
    throw new DebugAdapterError('out-of-range', `${name} must be between ${min} and ${max}`, { name, value: n, min, max });
  }
  return n;
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
  if (kind === 'address') {
    const address = asAddress(spec.address);
    const id = String(spec.id || `bp:address:${address}`);
    return { id, kind, address, enabled: spec.enabled !== false };
  }
  if (kind === 'function') {
    const fn = String(spec.function || '').trim();
    if (!fn) throw new DebugAdapterError('invalid-breakpoint', 'function breakpoint requires function');
    const address = spec.address == null ? null : asAddress(spec.address);
    const id = String(spec.id || `bp:function:${fn}:${address ?? ''}`);
    return { id, kind, function: fn, address, enabled: spec.enabled !== false };
  }
  if (kind === 'conditional') {
    if (spec.address == null) throw new DebugAdapterError('invalid-breakpoint', 'conditional breakpoint requires address');
    const address = asAddress(spec.address);
    const condition = String(spec.condition || '').trim();
    if (!condition) throw new DebugAdapterError('invalid-breakpoint', 'conditional breakpoint requires condition');
    const id = String(spec.id || `bp:conditional:${address}:${condition}`);
    return { id, kind, address, condition, enabled: spec.enabled !== false };
  }
  const address = asAddress(spec.address);
  const size = boundedInteger(spec.size, 1, 1, 4096, 'watchpoint size');
  const access = spec.access == null ? 'write' : String(spec.access).toLowerCase();
  if (!WATCHPOINT_ACCESS.includes(access)) {
    throw new DebugAdapterError('invalid-watchpoint-access', `unsupported watchpoint access: ${spec.access}`, { access: spec.access, allowed: WATCHPOINT_ACCESS });
  }
  const id = String(spec.id || `bp:memory:${address}:${size}:${access}`);
  return { id, kind: 'memory', address, size, access, enabled: spec.enabled !== false };
}

const METHOD_CAPABILITY = Object.freeze({
  attach:'attach', launch:'launch', pause:'pause', resume:'resume', stepInto:'stepInto', stepOver:'stepOver', stepOut:'stepOut',
  setBreakpoint:null, removeBreakpoint:'removeBreakpoint', listBreakpoints:'listBreakpoints',
  readRegisters:'readRegisters', writeRegister:'writeRegister', readMemory:'readMemory', writeMemory:'writeMemory',
  getThreads:'threads', getModules:'modules', getBacktrace:'backtrace', evaluate:'evaluate',
  trace:'traceFunction', traceCall:'traceCall', traceReturn:'traceReturn', traceBranch:'traceBranch',
  traceMemoryWrite:'traceMemoryWrite', traceMemoryRead:'traceMemoryRead', watchMemory:'watchpointMemory',
  getObjCRuntimeInfo:'objcRuntime', getSwiftRuntimeInfo:'swiftRuntime', cancel:'cancel', replay:'replay'
});

export function capabilityMethod(capability) {
  for (const [method, cap] of Object.entries(METHOD_CAPABILITY)) if (cap === capability) return method;
  return null;
}

export class DebugAdapter {
  constructor({ id, kind = 'generic', capabilities = {} } = {}) {
    this.id = String(id || `${kind}-adapter`);
    this.kind = kind;
    this.capabilities = normalizeCapabilities({ connect: true, disconnect: true, ...capabilities });
    this.connected = false;
  }
  negotiate(requested = null) {
    if (!requested) return this.capabilities;
    const keys = requested instanceof Set ? [...requested] : Array.isArray(requested) ? requested : Object.keys(requested);
    const out = {};
    for (const key of keys) {
      if (!DEBUG_CAPABILITIES.includes(key)) { out[key] = false; continue; }
      const method = capabilityMethod(key);
      out[key] = !!this.capabilities[key] && (!method || typeof this[method] === 'function');
    }
    return Object.freeze(out);
  }
  require(capability) {
    if (!this.capabilities[capability]) throw new DebugAdapterError('unsupported', `${this.kind} adapter does not support ${capability}`, { capability });
  }
  requireMethod(method) {
    if (!Object.prototype.hasOwnProperty.call(METHOD_CAPABILITY, method)) {
      throw new DebugAdapterError('unsupported-method', `unknown debug adapter method: ${method}`, { method });
    }
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
  async removeBreakpoint() { this.require('removeBreakpoint'); throw new DebugAdapterError('not-implemented', 'removeBreakpoint is not implemented'); }
  async listBreakpoints() { this.require('listBreakpoints'); throw new DebugAdapterError('not-implemented', 'listBreakpoints is not implemented'); }
  async readRegisters() { this.require('readRegisters'); }
  async writeRegister() { this.require('writeRegister'); }
  async readMemory() { this.require('readMemory'); }
  async writeMemory() { this.require('writeMemory'); }
  async getThreads() { this.require('threads'); }
  async getModules() { this.require('modules'); }
  async getBacktrace() { this.require('backtrace'); }
  async evaluate() { this.require('evaluate'); }
  async trace(...args) { this.require('traceFunction'); return this._traceCapability('traceFunction', ...args); }
  async traceCall(...args) { this.require('traceCall'); return this._traceCapability('traceCall', ...args); }
  async traceReturn(...args) { this.require('traceReturn'); return this._traceCapability('traceReturn', ...args); }
  async traceBranch(...args) { this.require('traceBranch'); return this._traceCapability('traceBranch', ...args); }
  async traceMemoryWrite(...args) { this.require('traceMemoryWrite'); return this._traceCapability('traceMemoryWrite', ...args); }
  async traceMemoryRead(...args) { this.require('traceMemoryRead'); return this._traceCapability('traceMemoryRead', ...args); }
  async _traceCapability(capability, ...args) {
    if (capability !== 'traceFunction' && this.trace !== DebugAdapter.prototype.trace) {
      return this.trace({ capability, args });
    }
    throw new DebugAdapterError('not-implemented', `${capability} is advertised but not implemented`, { capability });
  }
  async watchMemory() { this.require('watchpointMemory'); }
  async getObjCRuntimeInfo() { this.require('objcRuntime'); }
  async getSwiftRuntimeInfo() { this.require('swiftRuntime'); }
  async cancel() { this.require('cancel'); }
  async replay() { this.require('replay'); }
}
