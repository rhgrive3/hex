import { DEV_WORKER_FAILURE, DEV_WORKER_STATE } from '../../../ai/dev/workers/contracts.js';

const EVENT_QUEUE_LIMIT = 128;
const TERMINAL = new Set(['completed','failed','cancelled']);

export class DedicatedWorkerCoordinator {
  constructor({ controller, tabNodeId, now = () => new Date().toISOString() } = {}) {
    if (!controller?.on) throw new TypeError('DedicatedWorkerCoordinator requires a WorkerChatController.');
    if (!tabNodeId) throw new TypeError('DedicatedWorkerCoordinator requires tabNodeId.');
    this.controller = controller;
    this.tabNodeId = String(tabNodeId);
    this.now = now;
    this.claimed = null;
    this.lastResult = null;
    this.pendingTerminal = null;
    this.events = [];
    this.waiters = new Set();
    this.unsubscribe = controller.on((event) => this.onEvent(event));
  }
  advertisement() {
    return Object.freeze({ tabNodeId: this.tabNodeId, role: this.claimed ? 'worker' : 'available', state: this.claimed ? this.controller.observe().state : DEV_WORKER_STATE.AVAILABLE, claimed: !!this.claimed, runId: this.claimed?.runId || null, workerId: this.claimed?.workerId || null, chatgptConversationId: this.controller.workerConversation?.()?.id || null, lastHeartbeat: this.now(), dedicatedFrame: true });
  }
  async discover() { return Object.freeze([this.advertisement()]); }
  async claim({ runId, workerId } = {}) {
    const r = required(runId,'runId'), w = required(workerId,'workerId');
    if (this.claimed && (this.claimed.runId !== r || this.claimed.workerId !== w)) throw workerError(DEV_WORKER_FAILURE.WORKER_BUSY,'Dedicated Worker tab is already claimed.');
    this.claimed = { runId:r, workerId:w };
    this.lastResult = null;
    return this.withIdentity({ state: DEV_WORKER_STATE.STARTING, claimed:true, replayed: false });
  }
  async createChat(args={}) { this.assertClaim(args); return this.withIdentity(await this.controller.createChat(args)); }
  async send(args={}) { const c=this.assertClaim(args); return this.runTurn(() => this.controller.send(required(args.instruction,'instruction'), c)); }
  async followup(args={}) { const c=this.assertClaim(args); return this.runTurn(() => this.controller.followup(required(args.text ?? args.instruction,'text'), c)); }
  async nudge(args={}) { const c=this.assertClaim(args); return this.runTurn(() => this.controller.nudge(c), { allowImmediate:true }); }
  async observe(args={}) { this.assertClaim(args); return this.withIdentity(this.controller.observe()); }
  async stop(args={}) { this.assertClaim(args); const value=await this.controller.stop(); if (this.pendingTerminal) await this.pendingTerminal.promise.catch(()=>null); return this.withIdentity(value); }
  async result(args={}) { this.assertClaim(args); return this.lastResult || this.withIdentity(this.controller.result()); }
  async release(args={}) {
    this.assertClaim(args);
    if (this.controller.isActive?.()) throw workerError(DEV_WORKER_FAILURE.WORKER_BUSY,'Cannot release a generating dedicated Worker.');
    this.claimed=null; this.lastResult=null; return this.advertisement();
  }
  waitEvent({ events, runId=null }={}, { signal }={}) {
    const wanted = new Set((Array.isArray(events)?events:[events]).map(String).filter(Boolean));
    const idx=this.events.findIndex((event)=>matches(event,wanted,runId));
    if (idx>=0) return Promise.resolve(this.events.splice(idx,1)[0]);
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    return new Promise((resolve,reject)=>{
      const waiter={wanted,runId:runId==null?null:String(runId),resolve,reject,signal,onAbort:null};
      waiter.onAbort=()=>{this.waiters.delete(waiter);reject(abortError(signal?.reason));};
      signal?.addEventListener?.('abort',waiter.onAbort,{once:true}); this.waiters.add(waiter);
    });
  }
  close() {
    this.unsubscribe?.();
    const error = workerError(DEV_WORKER_FAILURE.TRANSPORT_FAILURE, 'Dedicated Worker closed.');
    for (const w of this.waiters) {
      w.signal?.removeEventListener?.('abort', w.onAbort);
      w.reject(error);
    }
    this.waiters.clear();
    this.events = [];
    this.pendingTerminal?.closeReject?.(error);
    this.pendingTerminal?.reject?.(error);
    this.pendingTerminal = null;
    this.claimed = null;
  }
  async runTurn(operation,{allowImmediate=false}={}) {
    const pending=this.armTerminal();
    try {
      const initial=await Promise.race([Promise.resolve().then(operation), pending.closePromise]);
      if(allowImmediate&&initial?.outcome==='still-working') return this.withIdentity(initial);
      await pending.promise;
      return this.lastResult||this.withIdentity(this.controller.result());
    }
    catch(error){ if(this.pendingTerminal===pending)this.pendingTerminal=null; pending.reject(error); throw error; }
  }
  armTerminal(){
    if(this.pendingTerminal)throw workerError(DEV_WORKER_FAILURE.WORKER_BUSY,'Worker completion already pending.');
    let resolve,reject,closeReject;
    const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});
    const closePromise=new Promise((_,rej)=>{closeReject=rej;});
    promise.catch(()=>{});
    closePromise.catch(()=>{});
    return this.pendingTerminal={promise,resolve,reject,closePromise,closeReject};
  }
  onEvent(event){ if(!event?.kind||!this.claimed)return; const normalized=this.normalizeEvent(event); this.enqueue(normalized); if(TERMINAL.has(event.kind)){this.lastResult=this.withIdentity(this.controller.result()); const pending=this.pendingTerminal;this.pendingTerminal=null;pending?.resolve(normalized);} }
  normalizeEvent(event){return Object.freeze({type:`worker.${event.kind}`,data:Object.freeze({runId:this.claimed?.runId||null,workerId:this.claimed?.workerId||null,...(event.data||{})}),observedAt:String(event.observedAt||this.now())});}
  enqueue(event){for(const w of [...this.waiters]){if(!matches(event,w.wanted,w.runId))continue;this.waiters.delete(w);w.signal?.removeEventListener?.('abort',w.onAbort);w.resolve(event);return;}this.events.push(event);while(this.events.length>EVENT_QUEUE_LIMIT)this.events.shift();}
  assertClaim(args){if(!this.claimed)throw workerError(DEV_WORKER_FAILURE.WORKER_NOT_CLAIMED,'Dedicated Worker is not claimed.');if(String(args.runId||'')!==this.claimed.runId||String(args.workerId||'')!==this.claimed.workerId)throw workerError(DEV_WORKER_FAILURE.CONVERSATION_MISMATCH,'Dedicated Worker claim identity mismatch.');return {...this.claimed};}
  withIdentity(value={}){return Object.freeze({...value,tabNodeId:this.tabNodeId,runId:this.claimed?.runId||null,workerId:this.claimed?.workerId||null,chatgptConversationId:value.chatgptConversationId||this.controller.workerConversation?.()?.id||null});}
}
function matches(event,wanted,runId){return wanted.has(event.type)&&(runId==null||String(event.data?.runId||'')===String(runId));}
function required(value,name){const text=String(value??'').trim();if(!text)throw new TypeError(`${name} is required.`);return text;}
function workerError(code,message){const error=new Error(message);error.code=code;return error;}
function abortError(reason){const error=workerError(DEV_WORKER_FAILURE.CANCELLED,String(reason||'cancelled'));error.name='AbortError';return error;}
