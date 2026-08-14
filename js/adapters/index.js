import { DebugAdapter, DebugAdapterError, asAddress, boundedInteger, normalizeBreakpoint, normalizeCapabilities } from '../debug/adapter.js';
import { RemoteProtocolClient } from '../debug/remote-protocol.js';
import { RuntimeMemoryMap, createSandboxMemoryMap, RUNTIME_HEAP_BASE, RUNTIME_HEAP_SIZE } from '../runtime/memory.js';
import { TraceRingBuffer } from '../trace/ring-buffer.js';
import { createFunctionSandbox, DEFAULT_OBJECT_BASE } from '../symbolic/function-sandbox.js';
import { symbolicExecute } from '../symbolic/executor.js';
import { STACK_TOP } from '../emu.js';

const REMOTE_ARRAY_LIMITS = Object.freeze({ threads:1024, modules:4096, backtrace:4096, trace:20000 });
const REMOTE_CALL_METHODS = new Set(['attach','launch','pause','resume','stepInto','stepOver','stepOut','readRegisters','writeRegister','readMemory','writeMemory','getThreads','getModules','getBacktrace','evaluate','trace','watchMemory']);

function cloneRegisters(emu) {
  const out = {};
  for (let i = 0; i <= 30; i++) out[`x${i}`] = emu.get(`x${i}`);
  out.sp = emu.sp; out.pc = emu.pc; return out;
}
function registerDelta(before, after) {
  const out = {};
  for (const key of Object.keys(after || {})) if (before[key] !== after[key]) out[key] = { before:before[key], after:after[key] };
  return out;
}
function classifyStop(result) {
  const reason = String(result && result.stopped || '');
  if (!reason) return { kind:'paused', message:null };
  if (/命令ぶん進んだ|timeout/i.test(reason)) return { kind:'timeout', message:reason };
  if (/unsupported|未対応|対応していない|実行できません|まだ実行できません/i.test(reason)) return { kind:'unsupported', message:reason };
  if (/cancelled|stale-request/i.test(reason)) return { kind:'cancelled', message:reason };
  if (/oob|unmapped|permission|fault|MMIO/i.test(reason)) return { kind:'fault', message:reason };
  if (/最初の呼び出し元まで戻ってきました/.test(reason)) return { kind:'return', message:reason };
  return { kind:'exception', message:reason };
}
function callsFromTrace(trace) {
  return (trace || []).filter((e) => /^(bl|blr)\b/i.test(e.text || '')).map((e) => {
    const match = /^bl\s+#?(0x[0-9a-f]+|[0-9]+)/i.exec(e.text || '');
    let target = null; try { if (match) target = BigInt(match[1]); } catch { target = null; }
    return { type:'call', address:e.addr ?? e.address, target, text:e.text };
  });
}
function returnsFromTrace(trace) {
  return (trace || []).filter((e) => /^ret\b/i.test(e.text || '')).map((e) => ({ type:'return', address:e.addr ?? e.address, text:e.text }));
}
function isConditionalBranch(text) { return /^((b\.[a-z]+)|cbz|cbnz|tbz|tbnz)\b/i.test(text || ''); }
function isRegisterName(reg) { return /^(x([0-9]|[12][0-9]|30)|w([0-9]|[12][0-9]|30)|sp|pc)$/.test(reg); }

function remoteArray(result, key, max, name) {
  const value = Array.isArray(result) ? result : result && Array.isArray(result[key]) ? result[key] : null;
  if (!value) throw new DebugAdapterError('malformed-remote', `${name} response must be an array`);
  if (value.length > max) throw new DebugAdapterError('too-large', `${name} response exceeds ${max} entries`);
  return value.slice();
}
function remoteBytes(result, expected) {
  const source = result instanceof Uint8Array ? [...result] : Array.isArray(result) ? result : result && Array.isArray(result.bytes) ? result.bytes : null;
  if (!source) throw new DebugAdapterError('malformed-remote', 'remote memory response must contain bytes');
  if (source.length !== expected) throw new DebugAdapterError('short-read', `remote memory read returned ${source.length} of ${expected} bytes`);
  for (const byte of source) if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new DebugAdapterError('malformed-remote', 'remote memory response contains an invalid byte');
  return Uint8Array.from(source);
}
function remoteRegisters(result) {
  const registers = result && result.registers && typeof result.registers === 'object' ? result.registers : result;
  if (!registers || typeof registers !== 'object' || Array.isArray(registers)) throw new DebugAdapterError('malformed-remote', 'remote register response must be an object');
  const entries = Object.entries(registers);
  if (entries.length > 256) throw new DebugAdapterError('too-large', 'remote register response exceeds 256 registers');
  const out = {};
  for (const [name,value] of entries) {
    if (name.length > 64) throw new DebugAdapterError('malformed-remote', 'remote register name is too long');
    if (typeof value === 'string' && value.length > 128) throw new DebugAdapterError('malformed-remote', 'remote register value is too long');
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint' && value != null) throw new DebugAdapterError('malformed-remote', 'remote register value must be scalar');
    out[name] = value;
  }
  return out;
}
function remoteTrace(result) {
  const trace = result && Array.isArray(result.events) ? result : Array.isArray(result) ? { events:result } : null;
  if (!trace) throw new DebugAdapterError('malformed-remote', 'remote trace response must contain events');
  if (trace.events.length > REMOTE_ARRAY_LIMITS.trace) throw new DebugAdapterError('too-large', `remote trace exceeds ${REMOTE_ARRAY_LIMITS.trace} events`);
  return { ...trace, events:trace.events.slice() };
}

export class LocalFunctionSandboxAdapter extends DebugAdapter {
  constructor(io, options = {}) {
    super({ id:options.id || 'local-function-sandbox', kind:'local-sandbox', capabilities:{
      launch:true,pause:true,resume:true,stepInto:true,breakpointAddress:true,readRegisters:true,writeRegister:true,
      readMemory:true,writeMemory:true,threads:true,modules:true,backtrace:true,evaluate:true,
      traceFunction:true,traceCall:true,traceReturn:true,traceBranch:true,traceMemoryWrite:true,cancel:true,replay:true
    }});
    this.io = io || {};
    this.options = options;
    this.sandbox = null;
    this.memoryMap = null;
    this.breakpoints = new Map();
    this.traceBuffer = new TraceRingBuffer(options.trace || {});
    this.epoch = 0;
    this.initialRegisters = null;
    this.lastResult = null;
    this.cancelled = false;
    this.running = false;
    this.traceCursor = 0;
    this.branchCursor = 0;
    this._suppressMemoryTrace = false;
  }
  async launch(spec = {}) {
    this.require('launch');
    const address = asAddress(spec.address ?? spec.functionAddress);
    const objectBase = spec.objectBase == null ? DEFAULT_OBJECT_BASE : asAddress(spec.objectBase);
    const heapBase = spec.heapBase == null ? RUNTIME_HEAP_BASE : asAddress(spec.heapBase,'heapBase');
    const heapSize = boundedInteger(spec.heapSize, RUNTIME_HEAP_SIZE, 0x1000, 16 * 1024 * 1024, 'heapSize');
    this.memoryMap = spec.memoryMap instanceof RuntimeMemoryMap ? spec.memoryMap : createSandboxMemoryMap({
      objectBase, objectSize:boundedInteger(spec.maxObjectSize, 0x10000, 0x100, 16 * 1024 * 1024, 'maxObjectSize'),
      stackTop:STACK_TOP, heapBase, heapSize, globals:spec.globals || [], mappings:spec.memoryMappings || []
    });
    this.sandbox = createFunctionSandbox(this.io, { objectBase, maxObjectSize:spec.maxObjectSize });
    const emu = this.sandbox.emulator;
    emu.heap = heapBase;
    const rawLoad = emu.load.bind(emu), rawStore = emu.store.bind(emu);
    emu.load = async (addr,size) => {
      const region = this.memoryMap.assert(addr,size,'read');
      const value = await rawLoad(addr,size);
      if (spec.traceMemoryReads && !this._suppressMemoryTrace) this.traceBuffer.push({ type:'memory-read', address:BigInt(addr), size, region:region.kind, value });
      return value;
    };
    emu.store = async (addr,size,value) => {
      const region = this.memoryMap.assert(addr,size,'write');
      const before = await rawLoad(addr,size);
      await rawStore(addr,size,value);
      if (!this._suppressMemoryTrace) this.traceBuffer.push({ type:'memory-write', address:BigInt(addr), size, region:region.kind, before, after:BigInt.asUintN(size * 8, BigInt(value)) });
    };
    this.traceBuffer.clear(); this.cancelled = false; this.running = false; this.traceCursor = 0; this.branchCursor = 0; this.epoch++;
    await this.sandbox.setup(address, {
      args:spec.arguments || spec.args || [], registers:spec.registers || {}, objectBase, objectAsArg0:spec.objectAsArg0,
      objectMemory:spec.objectMemory || spec.fakeObject || [], stackMemory:spec.stack || spec.stackMemory || [], watch:spec.watch || [],
      breakpoints:[...this.breakpoints.values()].filter((b) => b.enabled && b.address != null).map((b) => b.address)
    });
    this._suppressMemoryTrace = true;
    try {
      for (const item of spec.heap || []) await emu.store(asAddress(item.address), Number(item.size || 8), BigInt(item.value || 0));
      for (const item of spec.globalValues || []) await emu.store(asAddress(item.address), Number(item.size || 8), BigInt(item.value || 0));
    } finally { this._suppressMemoryTrace = false; }
    this.traceBuffer.clear();
    this.initialRegisters = cloneRegisters(emu);
    return { launched:true, address, epoch:this.epoch, memory:this.memoryMap.snapshot(), capabilities:this.capabilities };
  }
  ensureSandbox() { if (!this.sandbox) throw new DebugAdapterError('not-launched', 'launch a function before using the local sandbox'); return this.sandbox; }
  async disconnect() {
    this.cancelled = true; this.running = false; this.sandbox = null; this.memoryMap = null; this.initialRegisters = null; this.lastResult = null; this.traceBuffer.clear();
    return super.disconnect();
  }
  async pause() { this.cancelled = true; return { paused:true }; }
  async resume(options = {}) {
    const sandbox = this.ensureSandbox(); this.cancelled = !!(options.signal && options.signal.aborted);
    const maxSteps = boundedInteger(options.maxSteps, 20000, 1, 1000000, 'maxSteps');
    const timeoutMs = options.timeoutMs == null ? null : boundedInteger(options.timeoutMs, 2000, 10, 30000, 'timeoutMs');
    const started = Date.now();
    const onAbort = () => { this.cancelled = true; };
    if (options.signal && !options.signal.aborted) options.signal.addEventListener('abort', onAbort, { once:true });
    if (this.cancelled) sandbox.emulator.stopped = 'cancelled';
    this.running = true;
    try {
      const result = await sandbox.run({ maxSteps, onProgress:(n) => {
        if (this.cancelled) sandbox.emulator.stopped = 'cancelled';
        else if (timeoutMs != null && Date.now() - started >= timeoutMs) sandbox.emulator.stopped = 'timeout';
        if (options.onProgress) options.onProgress(n);
      } });
      this.lastResult = this._normalizeResult(result); return this.lastResult;
    } finally {
      this.running = false;
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    }
  }
  async stepInto() {
    const sandbox = this.ensureSandbox(); const before = cloneRegisters(sandbox.emulator); const raw = await sandbox.step();
    const after = cloneRegisters(sandbox.emulator); const event = { type:'instruction', address:before.pc, addr:before.pc, text:raw.text, ok:raw.ok, reason:raw.reason };
    this.traceBuffer.push(event);
    if (isConditionalBranch(raw.text)) {
      this.traceBuffer.push({ type:'branch', address:before.pc, text:raw.text, next:after.pc, taken:after.pc !== before.pc + 4n });
      this.branchCursor++;
    }
    for (const call of callsFromTrace([event])) this.traceBuffer.push(call);
    for (const ret of returnsFromTrace([event])) this.traceBuffer.push(ret);
    this.traceCursor = (sandbox.emulator.trace || []).length;
    return { ...raw, state:sandbox.state(), registerDelta:registerDelta(before,after), stop:classifyStop({ stopped:sandbox.emulator.stopped }) };
  }
  async setBreakpoint(spec) {
    const bp = normalizeBreakpoint(spec);
    if (bp.kind !== 'address') return super.setBreakpoint(bp);
    this.require('breakpointAddress'); this.breakpoints.set(bp.id,bp); if (this.sandbox && bp.enabled) this.sandbox.addBreakpoint(bp.address); return bp;
  }
  async removeBreakpoint(id) {
    const key = typeof id === 'object' ? id.id : String(id); const bp = this.breakpoints.get(key); if (!bp) return false;
    if (this.sandbox && bp.address != null) this.sandbox.removeBreakpoint(bp.address); this.breakpoints.delete(key); return true;
  }
  async readRegisters() { this.require('readRegisters'); return cloneRegisters(this.ensureSandbox().emulator); }
  async writeRegister(reg,value) {
    this.require('writeRegister');
    const name = String(reg);
    if (!isRegisterName(name)) throw new DebugAdapterError('invalid-register', `unsupported register: ${name}`);
    const sandbox = this.ensureSandbox(); const v = BigInt(value);
    if (name === 'pc') sandbox.emulator.pc = asAddress(v,'pc'); else sandbox.setRegister(name,v);
    return { register:name, value:name === 'pc' ? sandbox.emulator.pc : sandbox.getRegister(name) };
  }
  async readMemory(address,size) {
    this.require('readMemory'); const n = Number(size == null ? 8 : size);
    if (!Number.isSafeInteger(n) || n < 1) throw new DebugAdapterError('invalid-size','memory read size must be a positive safe integer');
    if (n > 1024*1024) throw new DebugAdapterError('too-large','memory read exceeds 1 MiB');
    this.memoryMap.assert(address,n,'read'); return this.ensureSandbox().emulator.dump(asAddress(address),n);
  }
  async writeMemory(address,bytes) {
    this.require('writeMemory'); const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []);
    if (data.length > 256*1024) throw new DebugAdapterError('too-large','memory write exceeds 256 KiB');
    if (!data.length) return { written:0 };
    const start = asAddress(address); this.memoryMap.assert(start,data.length,'write'); const emu = this.ensureSandbox().emulator;
    this._suppressMemoryTrace = true;
    try {
      for (let i=0;i<data.length;i+=8) {
        const n=Math.min(8,data.length-i); let value=0n;
        for(let j=n-1;j>=0;j--) value=(value<<8n)|BigInt(data[i+j]);
        await emu.store(start+BigInt(i),n,value);
      }
    } finally { this._suppressMemoryTrace = false; }
    return { written:data.length };
  }
  async getThreads() { return [{ id:'sandbox:0', name:'sandbox', state:this.running ? 'running':'stopped' }]; }
  async getModules() { return [{ id:'sandbox', name:'local function sandbox', base:null, synthetic:true }]; }
  async getBacktrace() { return (this.ensureSandbox().emulator.callStack || []).slice(-256).reverse().map((f,i) => ({ index:i, address:f.addr, returnAddress:f.ret })); }
  async evaluate(expression) {
    const text = String(expression || '').trim(); if (/^(x([0-9]|[12][0-9]|30)|sp|pc)$/.test(text)) return this.ensureSandbox().getRegister(text);
    throw new DebugAdapterError('unsupported-expression','local evaluate only accepts register names');
  }
  async trace(options = {}) { if (options.run) await this.resume(options); return this.traceBuffer.snapshot({ limit:options.limit || 4096 }); }
  async watchMemory(spec) { const bp = normalizeBreakpoint({ ...spec, kind:'memory' }); throw new DebugAdapterError('unsupported','hardware-style watchpoints are unavailable in local sandbox; use memory trace/watch fields', { breakpoint:bp }); }
  _normalizeResult(result) {
    const fullTrace = result.trace || [];
    const trace = fullTrace.slice(this.traceCursor); this.traceCursor = fullTrace.length;
    const allBranches = result.takenBranches || [];
    const branches = allBranches.slice(this.branchCursor); this.branchCursor = allBranches.length;
    for (const e of trace) this.traceBuffer.push({ type:'instruction', address:e.addr, text:e.text });
    for (const e of branches) this.traceBuffer.push({ type:'branch', ...e });
    const calls = callsFromTrace(trace), returns = returnsFromTrace(trace);
    const stop = classifyStop(result);
    if (stop.kind === 'return' && returns.length) returns[returns.length - 1].value = result.returnValue;
    for (const e of calls) this.traceBuffer.push(e);
    for (const e of returns) this.traceBuffer.push(e);
    const finalRegisters = cloneRegisters(this.sandbox.emulator);
    const traceSnapshot = this.traceBuffer.snapshot();
    const loads = traceSnapshot.events.filter((e) => e.type === 'memory-read');
    const stores = traceSnapshot.events.filter((e) => e.type === 'memory-write');
    return {
      engine:'local-function-sandbox', epoch:this.epoch, returnValue:result.returnValue, stop,
      registerDelta:registerDelta(this.initialRegisters || {}, finalRegisters), memoryDelta:result.touchedFields || [],
      memoryBefore:result.before || [], memoryAfter:result.after || [], modifiedRanges:result.modifiedObjectRanges || [],
      branches, calls, returns, loads, stores,
      exception:stop.kind === 'exception' ? stop.message : null, fault:stop.kind === 'fault' ? stop.message : null,
      unsupported:stop.kind === 'unsupported' ? stop.message : null, timeout:stop.kind === 'timeout', steps:result.steps,
      trace:{ ...traceSnapshot, incomplete:Number(result.steps || 0) > fullTrace.length }, reproducible:true
    };
  }
}

export class EmulatorAdapter extends LocalFunctionSandboxAdapter {
  constructor(io, options = {}) { super(io,{ ...options,id:options.id || 'emulator' }); this.kind = 'emulator'; }
}

export class SymbolicAdapter extends DebugAdapter {
  constructor(options = {}) { super({ id:options.id || 'symbolic', kind:'symbolic', capabilities:{ launch:true,evaluate:true,replay:true } }); this.ir = null; this.options = options; this.result = null; }
  async launch(spec = {}) { this.ir = spec.ir; if (!this.ir) throw new DebugAdapterError('missing-ir','symbolic adapter requires Semantic IR'); this.result = symbolicExecute(this.ir, spec.options || this.options); return this.result; }
  async evaluate() { return this.result; }
}

export class RemoteDebugAdapter extends DebugAdapter {
  constructor(transport, options = {}) {
    super({ id:options.id || 'remote-debug', kind:options.kind || 'remote', capabilities:options.capabilities || {} });
    this.protocol = new RemoteProtocolClient(transport, options.protocol || {}); this.epoch = 0; this.eventListeners = new Set();
    this.allowedCapabilities = this.capabilities;
    this.protocol.onEvent((event) => { if (event.epoch === this.epoch) for (const fn of this.eventListeners) fn(event); });
  }
  async connect(options = {}) {
    const hello = await this.protocol.request('connect', { client:'hex', requestedVersion:1, options }, { epoch:this.epoch });
    const advertised = normalizeCapabilities(hello && hello.capabilities || {});
    const negotiated = {};
    for (const [key, allowed] of Object.entries(this.allowedCapabilities)) negotiated[key] = key === 'connect' || key === 'disconnect' ? !!allowed : !!allowed && !!advertised[key];
    this.capabilities = normalizeCapabilities(negotiated); this.connected = true; return { adapter:this.id, capabilities:this.capabilities, remote:hello || null };
  }
  async disconnect() { if (this.connected) { try { await this.protocol.request('disconnect',{}, { epoch:this.epoch, timeoutMs:1000 }); } catch {} } this.connected=false; this.protocol.close(); this.eventListeners.clear(); return { disconnected:true }; }
  setEpoch(epoch) { this.epoch = Number(epoch); this.protocol.setEpoch(this.epoch); return this.epoch; }
  nextEpoch() { return this.setEpoch(this.epoch + 1); }
  onEvent(fn) { this.eventListeners.add(fn); return () => this.eventListeners.delete(fn); }
  call(method, params = {}, options = {}) {
    if (!REMOTE_CALL_METHODS.has(method)) throw new DebugAdapterError('unsupported-method', `remote debug method is not exposed: ${method}`);
    this.requireMethod(method); return this.protocol.request(method, params, { ...options, epoch:this.epoch });
  }
  attach(spec,requestOptions={}){return this.call('attach',spec,requestOptions)}
  launch(spec,requestOptions={}){return this.call('launch',spec,requestOptions)}
  pause(options={}){const {signal,...params}=options||{};return this.call('pause',params,{signal})}
  resume(options={}){const {signal,...params}=options||{};return this.call('resume',params,{signal})}
  stepInto(options={}){return this.call('stepInto',{},options)} stepOver(options={}){return this.call('stepOver',{},options)} stepOut(options={}){return this.call('stepOut',{},options)}
  setBreakpoint(spec){const bp=normalizeBreakpoint(spec); const cap=bp.kind==='address'?'breakpointAddress':bp.kind==='function'?'breakpointFunction':bp.kind==='conditional'?'breakpointConditional':'watchpointMemory'; this.require(cap); return this.protocol.request('setBreakpoint',bp,{epoch:this.epoch})}
  removeBreakpoint(id){if(!this.capabilities.breakpointAddress&&!this.capabilities.breakpointFunction&&!this.capabilities.breakpointConditional&&!this.capabilities.watchpointMemory)throw new DebugAdapterError('unsupported','remote adapter does not support breakpoints');return this.protocol.request('removeBreakpoint',{id:String(id)},{epoch:this.epoch})}
  async readRegisters(threadId){return remoteRegisters(await this.call('readRegisters',{threadId}))}
  writeRegister(reg,value,threadId){return this.call('writeRegister',{reg:String(reg),value:String(value),threadId})}
  async readMemory(address,size){const n=Number(size==null?1:size); if(!Number.isSafeInteger(n)||n<1) throw new DebugAdapterError('invalid-size','memory read size must be a positive safe integer'); if(n>256*1024) throw new DebugAdapterError('too-large','remote memory read exceeds 256 KiB'); return remoteBytes(await this.call('readMemory',{address:String(asAddress(address)),size:n}),n)}
  async writeMemory(address,bytes){const data=bytes instanceof Uint8Array?[...bytes]:Array.from(bytes||[]); if(data.length>64*1024) throw new DebugAdapterError('too-large','remote memory write exceeds 64 KiB'); for(const b of data)if(!Number.isInteger(b)||b<0||b>255)throw new DebugAdapterError('invalid-byte','memory write contains a non-byte value'); const result=await this.call('writeMemory',{address:String(asAddress(address)),bytes:data}); if(result&&result.written!=null&&Number(result.written)!==data.length)throw new DebugAdapterError('short-write',`remote memory write wrote ${result.written} of ${data.length} bytes`); return result||{written:data.length}}
  async getThreads(){return remoteArray(await this.call('getThreads'),'threads',REMOTE_ARRAY_LIMITS.threads,'threads')}
  async getModules(){return remoteArray(await this.call('getModules'),'modules',REMOTE_ARRAY_LIMITS.modules,'modules')}
  async getBacktrace(threadId){return remoteArray(await this.call('getBacktrace',{threadId}),'frames',REMOTE_ARRAY_LIMITS.backtrace,'backtrace')}
  evaluate(expression,context){return this.call('evaluate',{expression:String(expression).slice(0,4096),context})}
  async trace(options={}){const {signal,...params}=options||{};return remoteTrace(await this.call('trace',params,{signal}))}
  watchMemory(spec){return this.call('watchMemory',normalizeBreakpoint({...spec,kind:'memory'}))}
  getObjCRuntimeInfo(request={}){this.require('objcRuntime'); return this.protocol.request('objcRuntime',request,{epoch:this.epoch})}
  getSwiftRuntimeInfo(request={}){this.require('swiftRuntime'); return this.protocol.request('swiftRuntime',request,{epoch:this.epoch})}
}

export class LLDBCompatibleAdapter extends RemoteDebugAdapter {
  constructor(transport, options = {}) { super(transport,{ ...options,id:options.id||'lldb-compatible',kind:'lldb-compatible',capabilities:{ attach:true,launch:true,pause:true,resume:true,stepInto:true,stepOver:true,stepOut:true,breakpointAddress:true,breakpointFunction:true,breakpointConditional:true,watchpointMemory:true,readRegisters:true,writeRegister:true,readMemory:true,writeMemory:true,threads:true,modules:true,backtrace:true,evaluate:true,traceFunction:true,cancel:true,...options.capabilities } }); }
}
export class FridaCompatibleAdapter extends RemoteDebugAdapter {
  constructor(transport, options = {}) { super(transport,{ ...options,id:options.id||'frida-compatible',kind:'frida-compatible',capabilities:{ attach:true,launch:true,pause:true,resume:true,breakpointAddress:true,breakpointFunction:true,readRegisters:true,readMemory:true,writeMemory:true,threads:true,modules:true,backtrace:true,evaluate:true,traceFunction:true,traceCall:true,traceReturn:true,traceBranch:true,traceMemoryWrite:true,traceMemoryRead:true,objcRuntime:true,swiftRuntime:true,cancel:true,...options.capabilities } }); }
}

export class ReplayAdapter extends DebugAdapter {
  constructor(recording = {}, options = {}) { super({ id:options.id||'replay',kind:'replay',capabilities:{ launch:true,readRegisters:true,readMemory:true,threads:true,modules:true,backtrace:true,traceFunction:true,replay:true } }); this.recording=recording; }
  async launch(){return { replay:true, metadata:this.recording.metadata||null }}
  async readRegisters(){return remoteRegisters(this.recording.registers||{})}
  async readMemory(address,size){const n=Number(size==null?1:size); if(!Number.isSafeInteger(n)||n<1) throw new DebugAdapterError('invalid-size','replay memory read size must be a positive safe integer'); if(n>1024*1024) throw new DebugAdapterError('too-large','replay memory read exceeds 1 MiB'); const key=String(asAddress(address)); const bytes=this.recording.memory&&this.recording.memory[key]; if(!bytes)throw new DebugAdapterError('replay-miss',`recording has no memory at ${key}`); return remoteBytes(bytes,n)}
  async getThreads(){return remoteArray(this.recording.threads||[],'threads',REMOTE_ARRAY_LIMITS.threads,'threads')}
  async getModules(){return remoteArray(this.recording.modules||[],'modules',REMOTE_ARRAY_LIMITS.modules,'modules')}
  async getBacktrace(){return remoteArray(this.recording.backtrace||[],'frames',REMOTE_ARRAY_LIMITS.backtrace,'backtrace')}
  async trace(){return remoteTrace(this.recording.trace||{events:[]})}
}
