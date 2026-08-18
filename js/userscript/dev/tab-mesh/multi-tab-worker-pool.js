import { createDevWorkerParentRpcClient } from '../parent-rpc.js';
import { createAuthBroadcastPort } from './auth-broadcast-port.js';
import { createWorkerTabTicket, encodeWorkerTabUrl } from './worker-tab-ticket.js';

export const DEV_WORKER_POOL_MAX = 6;
const READY_TIMEOUT_MS = 20000;
const READY_POLL_MS = 250;

export class MultiTabWorkerPool {
  constructor({
    maxWorkers = DEV_WORKER_POOL_MAX,
    openTab = defaultOpenTab,
    BroadcastChannelRef = globalThis.BroadcastChannel,
    cryptoRef = globalThis.crypto,
    location = globalThis.location,
    now = () => new Date().toISOString(),
    sleep = delay,
  } = {}) {
    this.maxWorkers = boundedInt(maxWorkers, 1, DEV_WORKER_POOL_MAX, DEV_WORKER_POOL_MAX);
    this.openTab = openTab;
    this.BroadcastChannelRef = BroadcastChannelRef;
    this.cryptoRef = cryptoRef;
    this.location = location;
    this.now = now;
    this.sleep = sleep;
    this.slots = new Map();
    this.leases = new Map();
    this.waiters = [];
  }

  async provision({ size = this.maxWorkers, projectUrl = null, timeoutMs = READY_TIMEOUT_MS } = {}) {
    const wanted = boundedInt(size, 1, this.maxWorkers, this.maxWorkers);
    const created = [];
    for (let index = 1; index <= wanted; index++) {
      if (this.slots.get(index)?.ready) continue;
      const ticket = createWorkerTabTicket({ slot: index, projectUrl, cryptoRef: this.cryptoRef });
      const href = encodeWorkerTabUrl(ticket, { base: this.location?.href || 'https://chatgpt.com/' });
      const port = createAuthBroadcastPort(ticket, { BroadcastChannelRef: this.BroadcastChannelRef });
      const client = createDevWorkerParentRpcClient({ port, timeoutMs: 4000 });
      let handle = null;
      try { handle = await this.openTab(href, { slot: index, active: false }); }
      catch (error) { client.close(); port.close?.(); this.slots.set(index, failedSlot(index, ticket, error)); continue; }
      if (handle == null) { client.close(); port.close?.(); this.slots.set(index, failedSlot(index, ticket, poolError('popup-blocked','Browser blocked creation of a Worker tab.'))); continue; }
      const slot = { index, ticket, href, handle, port, client, ready:false, claimed:false, reserving:false, leaseId:null, workerId:null, runId:null, taskId:null, pending:null, lastResult:null, error:null, createdAt:this.now() };
      this.slots.set(index, slot);
      const ready = await this.awaitReady(slot, boundedInt(timeoutMs, 1000, 60000, READY_TIMEOUT_MS));
      if (ready) { slot.ready=true; created.push(this.publicSlot(slot)); }
      else { slot.error={code:'worker-tab-timeout',message:'Dedicated Worker tab did not become ready.'}; try{client.close();port.close?.();handle.close?.();}catch{} }
    }
    this.flushWaiters();
    return { maxWorkers:this.maxWorkers, requested:wanted, created, slots:this.status().slots, readyCount:[...this.slots.values()].filter((s)=>s.ready).length };
  }

  status() { return { maxWorkers:this.maxWorkers, readyCount:[...this.slots.values()].filter((s)=>s.ready).length, claimedCount:[...this.slots.values()].filter((s)=>s.claimed).length, waiting:this.waiters.length, slots:[...this.slots.values()].sort((a,b)=>a.index-b.index).map((s)=>this.publicSlot(s)) }; }

  async claim({ taskId = null, wait = true, signal = null } = {}) {
    const slot = this.availableSlot();
    if (slot) return this.claimSlot(slot, taskId);
    if (wait === false) throw poolError('worker-pool-full','All ready Worker slots are claimed.');
    if (signal?.aborted) throw abortError(signal.reason);
    return new Promise((resolve,reject)=>{
      const waiter={taskId:taskId==null?null:String(taskId),resolve,reject,signal,onAbort:null};
      waiter.onAbort=()=>{this.waiters=this.waiters.filter((item)=>item!==waiter);reject(abortError(signal?.reason));};
      signal?.addEventListener?.('abort',waiter.onAbort,{once:true});
      this.waiters.push(waiter);
    });
  }

  async createChat({ leaseId }={}) { const slot=this.requireLease(leaseId); return slot.client.createChat(this.identity(slot)); }

  async start({ leaseId, instruction }={}) {
    const slot=this.requireLease(leaseId);
    if (slot.pending) throw poolError('worker-busy','Worker slot already has an active task.');
    const text=String(instruction||'').trim(); if(!text) throw new TypeError('Worker instruction is required.');
    const pending = Promise.resolve().then(()=>slot.client.send({ ...this.identity(slot), instruction:text }));
    slot.pending = pending;
    slot.lastResult = null;
    pending.then((result)=>{slot.lastResult=result;slot.pending=null;},(error)=>{slot.lastResult={status:'failed',error:{code:String(error?.code||'provider-error'),message:String(error?.message||error).slice(0,512)}};slot.pending=null;}).finally(()=>this.flushWaiters());
    return { started:true, ...this.publicSlot(slot) };
  }

  async send({ leaseId, instruction }={}) { const slot=this.requireLease(leaseId); return slot.client.send({ ...this.identity(slot), instruction:String(instruction||'') }); }
  async followup({ leaseId, text }={}) { const slot=this.requireLease(leaseId); return slot.client.followup({ ...this.identity(slot), text:String(text||'') }); }
  async nudge({ leaseId }={}) { const slot=this.requireLease(leaseId); return slot.client.nudge(this.identity(slot)); }
  async stop({ leaseId }={}) { const slot=this.requireLease(leaseId); return slot.client.stop(this.identity(slot)); }
  async observe({ leaseId }={}) { const slot=this.requireLease(leaseId); return slot.client.observe(this.identity(slot)); }
  async result({ leaseId }={}) { const slot=this.requireLease(leaseId); if(slot.pending)return {status:'working',...this.publicSlot(slot)}; return slot.lastResult || slot.client.result(this.identity(slot)); }

  async release({ leaseId }={}) {
    const slot=this.requireLease(leaseId);
    if(slot.pending) throw poolError('worker-busy','Cannot release a Worker slot while its task is active.');
    try { await slot.client.release(this.identity(slot)); } catch (error) { if (String(error?.code||'') !== 'worker-not-claimed') throw error; }
    this.leases.delete(slot.leaseId);
    slot.claimed=false;slot.leaseId=null;slot.workerId=null;slot.runId=null;slot.taskId=null;slot.lastResult=null;
    this.flushWaiters();
    return this.publicSlot(slot);
  }

  close() { for(const slot of this.slots.values()){try{slot.client?.close?.();slot.port?.close?.();slot.handle?.close?.();}catch{}} for(const w of this.waiters){w.reject(poolError('transport-failure','Worker pool closed.'));} this.waiters=[];this.leases.clear();this.slots.clear(); }

  async awaitReady(slot, timeoutMs) {
    const started=Date.now();
    while(Date.now()-started<timeoutMs){
      try { const ads=await slot.client.discover({}); if(Array.isArray(ads)&&ads[0]?.dedicatedTab===true)return true; }
      catch{}
      await this.sleep(READY_POLL_MS);
    }
    return false;
  }
  availableSlot(){return [...this.slots.values()].sort((a,b)=>a.index-b.index).find((s)=>s.ready&&!s.claimed&&!s.reserving&&!s.error)||null;}
  async claimSlot(slot,taskId){
    if(slot.claimed||slot.reserving)throw poolError('worker-pool-full','Worker slot is already claimed or reserved.');
    slot.reserving=true;
    const leaseId=randomId('lease',this.cryptoRef),runId=randomId('poolrun',this.cryptoRef),workerId=randomId('worker',this.cryptoRef);
    try{
      await slot.client.claim({runId,workerId});
      slot.claimed=true;slot.leaseId=leaseId;slot.runId=runId;slot.workerId=workerId;slot.taskId=taskId==null?null:String(taskId);this.leases.set(leaseId,slot.index);
      return {leaseId,...this.publicSlot(slot)};
    }finally{
      slot.reserving=false;
      if(!slot.claimed)this.flushWaiters();
    }
  }
  requireLease(value){const id=String(value||'');const index=this.leases.get(id);const slot=index?this.slots.get(index):null;if(!slot||slot.leaseId!==id)throw poolError('lease-missing','Worker pool lease is invalid or expired.');return slot;}
  identity(slot){return {runId:slot.runId,workerId:slot.workerId};}
  publicSlot(slot){return {slot:slot.index,ready:!!slot.ready,claimed:!!slot.claimed,leaseId:slot.leaseId,workerId:slot.workerId,taskId:slot.taskId,working:!!slot.pending,chatgptConversationId:slot.lastResult?.chatgptConversationId||null,error:slot.error,createdAt:slot.createdAt||null};}
  flushWaiters(){while(this.waiters.length){const slot=this.availableSlot();if(!slot)return;const w=this.waiters.shift();w.signal?.removeEventListener?.('abort',w.onAbort);this.claimSlot(slot,w.taskId).then(w.resolve,w.reject);}}
}

async function defaultOpenTab(url, options={}) {
  const gm=globalThis.GM?.openInTab;
  if(typeof gm==='function') return gm(url,{active:options.active===true,insert:true,setParent:true});
  if(typeof globalThis.open==='function') return globalThis.open(url,'_blank');
  return null;
}
function failedSlot(index,ticket,error){return{index,ticket,ready:false,claimed:false,reserving:false,leaseId:null,workerId:null,runId:null,taskId:null,pending:null,lastResult:null,error:{code:String(error?.code||'worker-tab-open-failed'),message:String(error?.message||error).slice(0,512)},createdAt:new Date().toISOString()};}
function randomId(prefix,cryptoRef){if(!cryptoRef?.getRandomValues)throw new TypeError('WebCrypto is required for Worker pool identity.');const bytes=cryptoRef.getRandomValues(new Uint8Array(16));return `${prefix}-${[...bytes].map((v)=>v.toString(16).padStart(2,'0')).join('')}`;}
function boundedInt(value,min,max,fallback){if(value==null)return fallback;const n=Number(value);if(!Number.isFinite(n))throw new TypeError('Expected finite numeric bound.');return Math.min(max,Math.max(min,Math.floor(n)));}
function poolError(code,message){const error=new Error(message);error.code=code;return error;}
function abortError(reason){const error=poolError('cancelled',String(reason||'cancelled'));error.name='AbortError';return error;}
function delay(ms){return new Promise((resolve)=>setTimeout(resolve,ms));}
