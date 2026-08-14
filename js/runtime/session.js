import { TraceRingBuffer } from '../trace/ring-buffer.js';
import { DebugAdapterError, boundedInteger } from '../debug/adapter.js';

let nextSession = 1;

function jsonSafe(value, seen = new WeakSet(), depth = 0) {
  if (depth > 32) throw new DebugAdapterError('session-serialize','session data nesting is too deep');
  if (typeof value === 'bigint') return value.toString();
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map((item)=>jsonSafe(item,seen,depth+1));
  if (typeof value === 'object') {
    if (seen.has(value)) throw new DebugAdapterError('session-serialize','session data contains a cycle');
    seen.add(value);
    const out = {};
    for (const [key,item] of Object.entries(value)) {
      if (typeof item === 'function' || typeof item === 'symbol' || item === undefined) continue;
      out[key] = jsonSafe(item,seen,depth+1);
    }
    seen.delete(value);
    return out;
  }
  return null;
}

export class DebugSession {
  constructor(adapter, options = {}) {
    if (!adapter) throw new DebugAdapterError('adapter','DebugSession requires an adapter');
    this.id = String(options.id || `debug:${nextSession++}`); this.adapter = adapter; this.backend = adapter.kind;
    this.binaryHash = options.binaryHash || null; this.modules=[]; this.threads=[]; this.breakpoints=[]; this.experiments=[]; this.observations=[];
    this.traces = new TraceRingBuffer(options.trace || {}); this.epoch=1; this.connected=false; this.closed=false; this.controllers=new Set(); this._unsubscribe=null;
  }
  async connect(options = {}) {
    if (this.closed) throw new DebugAdapterError('session-closed','cannot reconnect a closed debug session');
    if (this.connected) return { adapter:this.adapter.id, capabilities:this.adapter.capabilities, reused:true };
    if (typeof this.adapter.setEpoch === 'function') this.adapter.setEpoch(this.epoch);
    const result = await this.adapter.connect(options); this.connected=true;
    if (typeof this.adapter.onEvent === 'function') this._unsubscribe=this.adapter.onEvent((event)=>this.acceptEvent(event));
    try { if (this.adapter.capabilities.modules) this.modules=await this.adapter.getModules(); } catch {}
    try { if (this.adapter.capabilities.threads) this.threads=await this.adapter.getThreads(); } catch {}
    return result;
  }
  acceptEvent(event) {
    if (this.closed) return false;
    if (event && event.epoch != null && Number(event.epoch) !== this.epoch) return false;
    if (event && event.type === 'event' && event.event) this.traces.push(event.event); else if (event) this.traces.push(event);
    return true;
  }
  newEpoch() {
    this.epoch++;
    if (typeof this.adapter.setEpoch === 'function') this.adapter.setEpoch(this.epoch); else if (typeof this.adapter.nextEpoch === 'function') this.adapter.nextEpoch();
    this.cancelAll('session-epoch-changed'); this.traces.clear(); return this.epoch;
  }
  controller() { const c=new AbortController(); this.controllers.add(c); c.signal.addEventListener('abort',()=>this.controllers.delete(c),{once:true}); return c; }
  releaseController(controller) { this.controllers.delete(controller); }
  cancelAll(reason='cancelled') { for (const c of [...this.controllers]) c.abort(reason); this.controllers.clear(); }
  addExperiment(exp) { this.experiments.push(exp); if (this.experiments.length>256) this.experiments.shift(); }
  addObservation(obs) { this.observations.push(obs); if (this.observations.length>1024) this.observations.shift(); }
  addBreakpoint(bp) { const i=this.breakpoints.findIndex((b)=>b.id===bp.id); if(i>=0)this.breakpoints[i]=bp; else this.breakpoints.push(bp); return bp; }
  removeBreakpoint(id) { const before=this.breakpoints.length; this.breakpoints=this.breakpoints.filter((b)=>b.id!==id); return before!==this.breakpoints.length; }
  serialize() {
    return jsonSafe({ version:1,id:this.id,backend:this.backend,binaryHash:this.binaryHash,modules:this.modules,threads:this.threads,breakpoints:this.breakpoints,experiments:this.experiments,observations:this.observations,traces:this.traces.snapshot(),epoch:this.epoch });
  }
  replayShape(experimentId = null) {
    const experiments=experimentId==null?this.experiments:this.experiments.filter((e)=>e.id===experimentId);
    return jsonSafe({ version:1,binaryHash:this.binaryHash,backend:this.backend,experiments,observations:this.observations.filter((o)=>!experimentId||o.experimentId===experimentId),trace:this.traces.snapshot() });
  }
  async disconnect() {
    if(this.closed)return;
    this.closed=true; this.cancelAll('disconnected'); if(typeof this._unsubscribe==='function')this._unsubscribe(); this._unsubscribe=null;
    try{await this.adapter.disconnect();}finally{this.connected=false;}
  }
}

export class DebugSessionManager {
  constructor(options={}){this.sessions=new Map();this.current=null;this.maxSessions=boundedInteger(options.maxSessions,8,1,32,'maxSessions');}
  create(adapter,options={}){
    if(this.sessions.size>=this.maxSessions)throw new DebugAdapterError('session-limit',`debug session limit reached (${this.maxSessions})`);
    for(const active of this.sessions.values())if(!active.closed&&active.adapter===adapter)throw new DebugAdapterError('adapter-in-use','a debug adapter cannot be shared by multiple live sessions');
    const session=new DebugSession(adapter,options);this.sessions.set(session.id,session);this.current=session;return session;
  }
  get(id){return this.sessions.get(id)||null;}
  switch(id){const next=this.get(id);if(!next)throw new DebugAdapterError('session-not-found',`debug session not found: ${id}`);if(this.current&&this.current!==next)this.current.newEpoch();this.current=next;return next;}
  async close(id){
    const s=this.get(id);if(!s)return false;
    try{await s.disconnect();}finally{this.sessions.delete(id);if(this.current===s)this.current=null;}
    return true;
  }
}
