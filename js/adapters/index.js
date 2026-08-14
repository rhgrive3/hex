import { DebugAdapter, DebugAdapterError, asAddress, boundedInteger, normalizeBreakpoint } from '../debug/adapter.js';
import { RemoteProtocolClient } from '../debug/remote-protocol.js';
import { RuntimeMemoryMap, createSandboxMemoryMap } from '../runtime/memory.js';
import { TraceRingBuffer } from '../trace/ring-buffer.js';
import { createFunctionSandbox, DEFAULT_OBJECT_BASE } from '../symbolic/function-sandbox.js';
import { symbolicExecute } from '../symbolic/executor.js';
import { STACK_TOP } from '../emu.js';

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
  if (/cancelled/i.test(reason)) return { kind:'cancelled', message:reason };
  if (/oob|unmapped|permission|fault|MMIO/i.test(reason)) return { kind:'fault', message:reason };
  if (/最初の呼び出し元まで戻ってきました/.test(reason)) return { kind:'return', message:reason };
  return { kind:'exception', message:reason };
}
function callsFromTrace(trace) {
  return (trace || []).filter((e) => /^bl?r?\b/i.test(e.text || '')).map((e) => {
    const match = /^bl\s+#?(0x[0-9a-f]+|[0-9]+)/i.exec(e.text || '');
    let target = null; try { if (match) target = BigInt(match[1]); } catch { target = null; }
    return { type:'call', address:e.addr, target, text:e.text };
  });
}
function returnsFromTrace(trace) {
  return (trace || []).filter((e) => /^ret\b/i.test(e.text || '')).map((e) => ({ type:'return', address:e.addr, text:e.text }));
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
    this.traceCursor = 0;
    this.branchCursor = 0;
  }
  async launch(spec = {}) {
    this.require('launch');
    const address = asAddress(spec.address ?? spec.functionAddress);
    const objectBase = spec.objectBase == null ? DEFAULT_OBJECT_BASE : asAddress(spec.objectBase);
    this.memoryMap = spec.memoryMap instanceof RuntimeMemoryMap ? spec.memoryMap : createSandboxMemoryMap({
      objectBase, objectSize:boundedInteger(spec.maxObjectSize, 0x10000, 0x100, 16 * 1024 * 1024, 'maxObjectSize'),
      stackTop:STACK_TOP, globals:spec.globals || [], mappings:spec.memoryMappings || []
    });
    this.sandbox = createFunctionSandbox(this.io, { objectBase, maxObjectSize:spec.maxObjectSize });
    const emu = this.sandbox.emulator;
    const rawLoad = emu.load.bind(emu), rawStore = emu.store.bind(emu);
    emu.load = async (addr,size) => { const region = this.memoryMap.assert(addr,size,'read'); const value = await rawLoad(addr,size); if (spec.traceMemoryReads) this.traceBuffer.push({ type:'memory-read', address:BigInt(addr), size, region:region.kind, value }); return value; };
    emu.store = async (addr,size,value) => { const region = this.memoryMap.assert(addr,size,'write'); const before = await rawLoad(addr,size); await rawStore(addr,size,value); this.traceBuffer.push({ type:'memory-write', address:BigInt(addr), size, region:region.kind, before, after:BigInt.asUintN(size * 8, BigInt(value)) }); };
    this.traceBuffer.clear(); this.cancelled = false; this.traceCursor = 0; this.branchCursor = 0; this.epoch++;
    await this.sandbox.setup(address, {
      args:spec.arguments || spec.args || [], registers:spec.registers || {}, objectBase, objectAsArg0:spec.objectAsArg0,
      objectMemory:spec.objectMemory || spec.fakeObject || [], stackMemory:spec.stack || spec.stackMemory || [], watch:spec.watch || [],
      breakpoints:[...this.breakpoints.values()].filter((b) => b.enabled && b.address != null).map((b) => b.address)
    });
    for (const item of spec.heap || []) await emu.store(asAddress(item.address), Number(item.size || 8), BigInt(item.value || 0));
    for (const item of spec.globalValues || []) await emu.store(asAddress(item.address), Number(item.size || 8), BigInt(item.value || 0));
    this.traceBuffer.clear();
    this.initialRegisters = cloneRegisters(emu);
    return { launched:true, address, epoch:this.epoch, memory:this.memoryMap.snapshot(), capabilities:this.capabilities };
  }
  ensureSandbox() { if (!this.sandbox) throw new DebugAdapterError('not-launched', 'launch a function before using the local sandbox'); return this.sandbox; }
  async pause() { this.cancelled = true; return { paused:true }; }
  async resume(options = {}) {
    const sandbox = this.ensureSandbox(); this.cancelled = false;
    const maxSteps = boundedInteger(options.maxSteps, 20000, 1, 1000000, 'maxSteps');
    const timeoutMs = options.timeoutMs == null ? null : boundedInteger(options.timeoutMs, 2000, 10, 30000, 'timeoutMs');
    const started = Date.now();
    const result = await sandbox.run({ maxSteps, onProgress:(n) => {
      if (this.cancelled) sandbox.emulator.stopped = 'cancelled';
      else if (timeoutMs != null && Date.now() - started >= timeoutMs) sandbox.emulator.stopped = 'timeout';
      if (options.onProgress) options.onProgress(n);
    } });
    this.lastResult = this._normalizeResult(result); return this.lastResult;
  }
  async stepInto() {
    const sandbox = this.ensureSandbox(); const before = cloneRegisters(sandbox.emulator); const raw = await sandbox.step();
    const after = cloneRegisters(sandbox.emulator); const event = { type:'instruction', address:before.pc, text:raw.text, ok:raw.ok, reason:raw.reason };
    this.traceBuffer.push(event);
    if (/^((b\.[a-z]+)|cbz|cbnz|tbz|tbnz)\b/i.test(raw.text || '')) this.traceBuffer.push({ type:'branch', address:before.pc, text:raw.text, next:after.pc, taken:after.pc !== before.pc + 4n });
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
  async writeRegister(reg,value) { this.require('writeRegister'); this.ensureSandbox().setRegister(String(reg), BigInt(value)); return { register:String(reg), value:this.ensureSandbox().getRegister(String(reg)) }; }
  async readMemory(address,size) { this.require('readMemory'); const n = boundedInteger(size,8,1,1024*1024,'size'); this.memoryMap.assert(address,n,'read'); return this.ensureSandbox().emulator.dump(asAddress(address),n); }
  async writeMemory(address,bytes) {
    this.require('writeMemory'); const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || []); if (data.length > 1024*1024) throw new DebugAdapterError('too-large','memory write exceeds 1 MiB');
    this.memoryMap.assert(address,data.length,'write'); const emu = this.ensureSandbox().emulator; for (let i=0;i<data.length;i++) await emu.store(asAddress(address)+BigInt(i),1,BigInt(data[i])); return { written:data.length };
  }
  async getThreads() { return [{ id:'sandbox:0', name:'sandbox', state:this.ensureSandbox().emulator.stopped ? 'stopped':'running' }]; }
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
    for (const e of calls) this.traceBuffer.push(e);
    for (const e of returns) this.traceBuffer.push(e);
    const finalRegisters = cloneRegisters(this.sandbox.emulator);
    const stop = classifyStop(result);
    const traceSnapshot = this.traceBuffer.snapshot();
    const loads = traceSnapshot.events.filter((e) => e.type === 'memory-read');
    const stores = traceSnapshot.events.filter((e) => e.type === 'memory-write');
    return {
      engine:'local-function-sandbox', epoch:this.epoch, returnValue:result.returnValue, stop,
      registerDelta:registerDelta(this.initialRegisters || {}, finalRegisters), memoryDelta:result.touchedFields || [],
      modifiedRanges:result.modifiedObjectRanges || [], branches, calls, returns, loads, stores,
      exception:stop.kind === 'exception' ? stop.message : null, fault:stop.kind === 'fault' ? stop.message : null,
      unsupported:stop.kind === 'unsupported' ? stop.message : null, timeout:stop.kind === 'timeout', steps:result.steps,
      trace:traceSnapshot, reproducible:true
    };
  }
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
    this.protocol.onEvent((event) => { if (event.epoch === this.epoch) for (const fn of this.eventListeners) fn(event); });
  }
  async connect(options = {}) {
    const hello = await this.protocol.request('connect', { client:'hex', requestedVersion:1, options }, { epoch:this.epoch });
    this.capabilities = Object.freeze({ ...this.capabilities, ...(hello && hello.capabilities || {}) }); this.connected = true; return { adapter:this.id, capabilities:this.capabilities, remote:hello || null };
  }
  async disconnect() { if (this.connected) { try { await this.protocol.request('disconnect',{}, { epoch:this.epoch, timeoutMs:1000 }); } catch {} } this.connected=false; this.protocol.close(); return { disconnected:true }; }
  setEpoch(epoch) { this.epoch = Number(epoch) || 0; this.protocol.setEpoch(this.epoch); return this.epoch; }
  nextEpoch() { return this.setEpoch(this.epoch + 1); }
  onEvent(fn) { this.eventListeners.add(fn); return () => this.eventListeners.delete(fn); }
  call(method, params = {}, options = {}) { this.requireMethod(method); return this.protocol.request(method, params, { ...options, epoch:this.epoch }); }
  attach(spec){return this.call('attach',spec)} launch(spec){return this.call('launch',spec)} pause(){return this.call('pause')} resume(){return this.call('resume')}
  stepInto(){return this.call('stepInto')} stepOver(){return this.call('stepOver')} stepOut(){return this.call('stepOut')}
  setBreakpoint(spec){const bp=normalizeBreakpoint(spec); const cap=bp.kind==='address'?'breakpointAddress':bp.kind==='function'?'breakpointFunction':bp.kind==='conditional'?'breakpointConditional':'watchpointMemory'; this.require(cap); return this.protocol.request('setBreakpoint',bp,{epoch:this.epoch})} removeBreakpoint(id){return this.protocol.request('removeBreakpoint',{id:String(id)},{epoch:this.epoch})}
  readRegisters(threadId){return this.call('readRegisters',{threadId})} writeRegister(reg,value,threadId){return this.call('writeRegister',{reg:String(reg),value:String(value),threadId})}
  readMemory(address,size){const n=boundedInteger(size,1,1,4*1024*1024,'size'); return this.call('readMemory',{address:String(asAddress(address)),size:n})}
  writeMemory(address,bytes){const data=bytes instanceof Uint8Array?[...bytes]:Array.from(bytes||[]); if(data.length>4*1024*1024) throw new DebugAdapterError('too-large','memory write exceeds 4 MiB'); return this.call('writeMemory',{address:String(asAddress(address)),bytes:data})}
  getThreads(){return this.call('getThreads')} getModules(){return this.call('getModules')} getBacktrace(threadId){return this.call('getBacktrace',{threadId})}
  evaluate(expression,context){return this.call('evaluate',{expression:String(expression).slice(0,4096),context})} trace(options){return this.call('trace',options||{})} watchMemory(spec){return this.call('watchMemory',normalizeBreakpoint({...spec,kind:'memory'}))}
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
  async readRegisters(){return this.recording.registers||{}}
  async readMemory(address,size){const key=String(asAddress(address)); const bytes=this.recording.memory&&this.recording.memory[key]; return Uint8Array.from((bytes||[]).slice(0,boundedInteger(size,1,1,1024*1024,'size')))}
  async getThreads(){return this.recording.threads||[]}
  async getModules(){return this.recording.modules||[]}
  async getBacktrace(){return this.recording.backtrace||[]}
  async trace(){return this.recording.trace||{events:[]}}
}
