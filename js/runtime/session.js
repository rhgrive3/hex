import { TraceRingBuffer } from '../trace/ring-buffer.js';
import { DebugAdapterError, boundedInteger } from '../debug/adapter.js';
import { encodeWireValue } from '../debug/remote-protocol.js';

let nextSession = 1;

function sessionSafe(value) {
  try { return encodeWireValue(value); }
  catch (error) {
    if (error instanceof DebugAdapterError) throw new DebugAdapterError('session-serialize', error.message, error.details);
    throw new DebugAdapterError('session-serialize', 'session data is not serializable');
  }
}

export class DebugSession {
  constructor(adapter, options = {}) {
    if (!adapter) throw new DebugAdapterError('adapter','DebugSession requires an adapter');
    this.id = String(options.id || `debug:${nextSession++}`); this.adapter = adapter; this.backend = adapter.kind;
    this.binaryHash = options.binaryHash || null; this.modules=[]; this.threads=[]; this.breakpoints=[]; this.experiments=[]; this.observations=[];
    this.traces = new TraceRingBuffer(options.trace || {}); this.epoch=1; this.connected=false; this.closed=false; this.controllers=new Set(); this._unsubscribe=null;
    this.refreshErrors={modules:null,threads:null}; this._onClosed=typeof options.onClosed==='function'?options.onClosed:null;
  }
  async connect(options = {}) {
    if (this.closed) throw new DebugAdapterError('session-closed','cannot reconnect a closed debug session');
    if (this.connected) return { adapter:this.adapter.id, capabilities:this.adapter.capabilities, reused:true };
    if (typeof this.adapter.setEpoch === 'function') this.adapter.setEpoch(this.epoch);
    let result;
    try {
      result = await this.adapter.connect(options);
      if (typeof this.adapter.onEvent === 'function') {
        const unsubscribe = this.adapter.onEvent((event)=>this.acceptEvent(event));
        if (unsubscribe != null && typeof unsubscribe !== 'function') throw new DebugAdapterError('event-subscription','adapter onEvent must return an unsubscribe function');
        this._unsubscribe=unsubscribe || null;
      }
      this.connected=true;
    } catch (error) {
      if (typeof this._unsubscribe==='function') { try { this._unsubscribe(); } catch {} }
      this._unsubscribe=null; this.connected=false;
      try { if (this.adapter.connected && typeof this.adapter.disconnect==='function') await this.adapter.disconnect(); } catch {}
      throw error;
    }
    await this.refreshState();
    return result;
  }
  async refreshState() {
    if (this.adapter.capabilities.modules) {
      try {
        const next=await this.adapter.getModules();
        if (Array.isArray(next)) this.modules=next;
        this.refreshErrors.modules=null;
      } catch (error) {
        this.refreshErrors.modules={code:error?.code||'refresh-failed',message:String(error?.message||error)};
      }
    }
    if (this.adapter.capabilities.threads) {
      try {
        const next=await this.adapter.getThreads();
        if (Array.isArray(next)) this.threads=next;
        this.refreshErrors.threads=null;
      } catch (error) {
        this.refreshErrors.threads={code:error?.code||'refresh-failed',message:String(error?.message||error)};
      }
    }
    return {modules:this.modules,threads:this.threads,errors:{...this.refreshErrors}};
  }
  acceptEvent(event) {
    if (this.closed) return false;
    if (event && event.epoch != null && Number(event.epoch) !== this.epoch) return false;
    if (event) this.traces.push(event);
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
    return sessionSafe({ version:2,id:this.id,backend:this.backend,binaryHash:this.binaryHash,modules:this.modules,threads:this.threads,refreshErrors:this.refreshErrors,breakpoints:this.breakpoints,experiments:this.experiments,observations:this.observations,traces:this.traces.snapshot(),epoch:this.epoch });
  }
  replayShape(experimentId = null) {
    const experiments=experimentId==null?this.experiments:this.experiments.filter((e)=>e.id===experimentId);
    return sessionSafe({ version:2,binaryHash:this.binaryHash,backend:this.backend,experiments,observations:this.observations.filter((o)=>!experimentId||o.experimentId===experimentId),trace:this.traces.snapshot() });
  }
  async disconnect() {
    if(this.closed)return;
    this.closed=true; this.cancelAll('disconnected'); if(typeof this._unsubscribe==='function') { try { this._unsubscribe(); } catch {} } this._unsubscribe=null;
    try{await this.adapter.disconnect();}finally{
      this.connected=false;
      const onClosed=this._onClosed; this._onClosed=null;
      if(onClosed) { try { onClosed(this); } catch {} }
    }
  }
}

export class DebugSessionManager {
  constructor(options={}){this.sessions=new Map();this.current=null;this.maxSessions=boundedInteger(options.maxSessions,8,1,32,'maxSessions');}
  create(adapter,options={}){
    if(this.sessions.size>=this.maxSessions)throw new DebugAdapterError('session-limit',`debug session limit reached (${this.maxSessions})`);
    for(const active of this.sessions.values())if(!active.closed&&active.adapter===adapter)throw new DebugAdapterError('adapter-in-use','a debug adapter cannot be shared by multiple live sessions');
    const session=new DebugSession(adapter,{...options,onClosed:(closed)=>this._sessionClosed(closed)});
    if(this.sessions.has(session.id)) throw new DebugAdapterError('duplicate-session-id',`debug session id already exists: ${session.id}`,{id:session.id});
    this.sessions.set(session.id,session);this.current=session;return session;
  }
  _sessionClosed(session){
    if(this.sessions.get(session.id)===session)this.sessions.delete(session.id);
    if(this.current===session)this.current=null;
  }
  get(id){return this.sessions.get(id)||null;}
  switch(id){
    const next=this.get(id);if(!next)throw new DebugAdapterError('session-not-found',`debug session not found: ${id}`);
    // Selecting a session is UI/manager state and must not invalidate execution state.
    this.current=next;return next;
  }
  async close(id){
    const s=this.get(id);if(!s)return false;
    try{await s.disconnect();}finally{this._sessionClosed(s);}
    return true;
  }
}
