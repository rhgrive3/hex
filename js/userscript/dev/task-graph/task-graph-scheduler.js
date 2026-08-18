const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const MAX_TASKS = 96;
const MAX_DEPENDENCIES = 24;
const MAX_ATTEMPTS = 3;
const POLL_MS = 250;
const TERMINAL = new Set(['completed','failed','blocked','cancelled']);

export class DynamicTaskGraph {
  constructor({ pool, now = () => new Date().toISOString(), sleep = delay } = {}) {
    if (!pool || typeof pool.claim !== 'function' || typeof pool.start !== 'function') throw new TypeError('DynamicTaskGraph requires a Worker pool.');
    this.pool = pool;
    this.now = now;
    this.sleep = sleep;
    this.tasks = new Map();
    this.running = new Map();
    this.loopPromise = null;
    this.waiters = new Set();
    this.cancelled = false;
    this.version = 0;
  }

  create({ tasks = [] } = {}) {
    if (this.loopPromise) throw graphError('graph-running','Cannot replace a running task graph.');
    this.tasks.clear(); this.running.clear(); this.cancelled=false; this.version += 1;
    this.add({ tasks });
    return this.status();
  }

  add({ tasks = [] } = {}) {
    if (!Array.isArray(tasks) || !tasks.length) throw new TypeError('Task graph add requires a non-empty tasks array.');
    if (this.tasks.size + tasks.length > MAX_TASKS) throw graphError('task-limit',`Task graph exceeds ${MAX_TASKS} tasks.`);
    const incoming = tasks.map(normalizeTask);
    for (const task of incoming) if (this.tasks.has(task.id) || incoming.some((other) => other !== task && other.id === task.id)) throw graphError('task-duplicate',`Duplicate task id: ${task.id}`);
    for (const task of incoming) this.tasks.set(task.id, task);
    try { validateGraph(this.tasks); }
    catch (error) { for (const task of incoming) this.tasks.delete(task.id); throw error; }
    this.version += 1;
    this.ensureLoop();
    return this.status();
  }

  replan({ add = [], cancel = [] } = {}) {
    for (const id of normalizeIds(cancel)) {
      const task = this.tasks.get(id);
      if (!task || TERMINAL.has(task.status)) continue;
      if (task.status === 'running') throw graphError('task-running',`Cannot synchronously replan a running task: ${id}. Cancel the graph or wait for the task.`);
      task.status='cancelled'; task.finishedAt=this.now();
    }
    if (Array.isArray(add) && add.length) this.add({ tasks:add });
    this.version += 1;
    this.ensureLoop();
    return this.status();
  }

  start() { this.ensureLoop(true); return this.status(); }

  async awaitCompletion({ signal = null } = {}) {
    if (this.isTerminal()) return this.status();
    if (signal?.aborted) throw abortError(signal.reason);
    this.ensureLoop(true);
    return new Promise((resolve,reject)=>{
      const waiter={resolve,reject,signal,onAbort:null};
      waiter.onAbort=()=>{this.waiters.delete(waiter);reject(abortError(signal?.reason));};
      signal?.addEventListener?.('abort',waiter.onAbort,{once:true});
      this.waiters.add(waiter);
    });
  }

  async cancel() {
    this.cancelled=true;
    const active=[...this.running.values()];
    await Promise.allSettled(active.map(async ({task,leaseId})=>{
      try { await this.pool.stop({leaseId}); } catch {}
      try { await this.pool.release({leaseId}); } catch {}
      task.status='cancelled';task.finishedAt=this.now();task.leaseId=null;
    }));
    this.running.clear();
    for (const task of this.tasks.values()) if (!TERMINAL.has(task.status)) { task.status='cancelled';task.finishedAt=this.now(); }
    this.finishIfTerminal();
    return this.status();
  }

  status() {
    const tasks=[...this.tasks.values()].map(publicTask);
    const counts={}; for(const task of tasks) counts[task.status]=(counts[task.status]||0)+1;
    return { schema:'hex-dev-task-graph-v1', version:this.version, running:!!this.loopPromise, terminal:this.isTerminal(), counts, tasks };
  }

  ensureLoop(force=false) {
    if (this.loopPromise || this.cancelled || (!force && ![...this.tasks.values()].some((task)=>['pending','ready'].includes(task.status)))) return;
    this.loopPromise=this.runLoop().finally(()=>{this.loopPromise=null;this.finishIfTerminal();});
  }

  async runLoop() {
    while(!this.cancelled) {
      this.updateBlockedAndReady();
      let launched=0;
      const status=this.pool.status?.() || {readyCount:6,claimedCount:this.running.size};
      let free=Math.max(0,Number(status.readyCount||0)-Number(status.claimedCount||0));
      if (!Number.isFinite(free)) free=0;
      for (const task of [...this.tasks.values()].filter((item)=>item.status==='ready')) {
        if (free<=0) break;
        const started=await this.launch(task).catch((error)=>{ if(String(error?.code||'')==='worker-pool-full') return false; this.failTask(task,error); return false; });
        if(started){launched+=1;free-=1;}
      }
      if (this.running.size===0) {
        this.updateBlockedAndReady();
        if (this.isTerminal()) return;
        if (launched===0 && ![...this.tasks.values()].some((task)=>task.status==='ready')) return;
      }
      if (this.running.size>0) await Promise.race([...this.running.values()].map((entry)=>entry.done));
      else await this.sleep(POLL_MS);
    }
  }

  async launch(task) {
    const lease=await this.pool.claim({taskId:task.id,wait:false});
    task.status='running';task.attempt+=1;task.startedAt=task.startedAt||this.now();task.leaseId=lease.leaseId;task.workerSlot=lease.slot;task.lastWorkerId=lease.workerId||null;
    await this.pool.createChat({leaseId:lease.leaseId});
    await this.pool.start({leaseId:lease.leaseId,instruction:task.instruction});
    const done=this.monitor(task,lease).finally(()=>this.running.delete(task.id));
    this.running.set(task.id,{task,leaseId:lease.leaseId,done});
    return true;
  }

  async monitor(task,lease) {
    let result=null,error=null;
    try {
      while(!this.cancelled) {
        result=await this.pool.result({leaseId:lease.leaseId});
        if(String(result?.status||'').toLowerCase()!=='working') break;
        await this.sleep(POLL_MS);
      }
      if(this.cancelled) return;
      if(isSuccess(result)) {
        task.status='completed';task.result=sanitizeResult(result);task.error=null;task.finishedAt=this.now();
      } else {
        error=graphError(String(result?.error?.code||'worker-failed'),String(result?.error?.message||`Worker task ${task.id} failed.`));
        this.failTask(task,error,result);
      }
    } catch(caught) { error=caught; if(!this.cancelled)this.failTask(task,caught); }
    finally {
      try { await this.pool.release({leaseId:lease.leaseId}); } catch(releaseError) { if(!error && !this.cancelled && task.status!=='completed') this.failTask(task,releaseError); }
      task.leaseId=null;
      this.updateBlockedAndReady();
      this.ensureLoop();
    }
  }

  failTask(task,error,result=null) {
    task.error={code:String(error?.code||'worker-failed').slice(0,64),message:String(error?.message||error).slice(0,600)};
    if(result) task.result=sanitizeResult(result);
    if(task.attempt<task.maxAttempts){task.status='pending';task.workerSlot=null;task.leaseId=null;task.retriedAt=this.now();}
    else {task.status='failed';task.finishedAt=this.now();}
  }

  updateBlockedAndReady() {
    for(const task of this.tasks.values()) {
      if(!['pending','ready'].includes(task.status)) continue;
      const deps=task.dependsOn.map((id)=>this.tasks.get(id)).filter(Boolean);
      if(deps.some((dep)=>['failed','blocked','cancelled'].includes(dep.status))){task.status='blocked';task.finishedAt=this.now();task.error={code:'dependency-failed',message:'A task dependency did not complete successfully.'};continue;}
      task.status=deps.every((dep)=>dep.status==='completed')?'ready':'pending';
    }
  }

  isTerminal(){return this.tasks.size>0&&[...this.tasks.values()].every((task)=>TERMINAL.has(task.status));}
  finishIfTerminal(){if(!this.isTerminal())return;const snapshot=this.status();for(const w of [...this.waiters]){this.waiters.delete(w);w.signal?.removeEventListener?.('abort',w.onAbort);w.resolve(snapshot);}}
}

function normalizeTask(value) {
  if(!plainRecord(value))throw new TypeError('Task graph task must be a plain object.');
  const id=String(value.id||'').trim();if(!TASK_ID.test(id))throw new TypeError(`Invalid task id: ${value.id}`);
  const instruction=String(value.instruction||'').trim();if(!instruction||instruction.length>24000)throw new TypeError(`Task ${id} instruction must be 1-24000 characters.`);
  const dependsOn=normalizeIds(value.dependsOn||[]);if(dependsOn.length>MAX_DEPENDENCIES)throw graphError('dependency-limit',`Task ${id} has too many dependencies.`);
  const maxAttempts=boundedInt(value.maxAttempts,1,MAX_ATTEMPTS,2);
  return {id,instruction,dependsOn,maxAttempts,attempt:0,status:'pending',ownership:normalizeStrings(value.ownership,16,120),integrationHint:String(value.integrationHint||'').slice(0,600)||null,result:null,error:null,leaseId:null,workerSlot:null,lastWorkerId:null,startedAt:null,finishedAt:null,retriedAt:null};
}
function validateGraph(tasks) {
  for(const task of tasks.values())for(const dep of task.dependsOn){if(dep===task.id)throw graphError('dependency-cycle',`Task ${task.id} depends on itself.`);if(!tasks.has(dep))throw graphError('dependency-missing',`Task ${task.id} depends on unknown task ${dep}.`);}
  const visiting=new Set(),visited=new Set();
  const visit=(id)=>{if(visited.has(id))return;if(visiting.has(id))throw graphError('dependency-cycle',`Task graph contains a cycle at ${id}.`);visiting.add(id);for(const dep of tasks.get(id).dependsOn)visit(dep);visiting.delete(id);visited.add(id);};
  for(const id of tasks.keys())visit(id);
}
function publicTask(task){return{id:task.id,status:task.status,dependsOn:[...task.dependsOn],attempt:task.attempt,maxAttempts:task.maxAttempts,ownership:[...task.ownership],integrationHint:task.integrationHint,workerSlot:task.workerSlot,lastWorkerId:task.lastWorkerId,result:task.result,error:task.error,startedAt:task.startedAt,finishedAt:task.finishedAt,retriedAt:task.retriedAt};}
function isSuccess(result){const status=String(result?.status||'').toLowerCase();return ['completed','complete','success','succeeded'].includes(status)||(!!result?.responseText&&!result?.error&&!['failed','cancelled'].includes(status));}
function sanitizeResult(value){if(value==null||typeof value==='string'||typeof value==='boolean'||typeof value==='number')return value;if(Array.isArray(value))return value.slice(0,64).map(sanitizeResult);if(plainRecord(value)){const out={};for(const [k,v] of Object.entries(value).slice(0,64))out[k]=sanitizeResult(v);return out;}return String(value).slice(0,600);}
function normalizeIds(value){const list=Array.isArray(value)?value:[value];return[...new Set(list.map((item)=>String(item||'').trim()).filter(Boolean).map((id)=>{if(!TASK_ID.test(id))throw new TypeError(`Invalid task id: ${id}`);return id;}))];}
function normalizeStrings(value,maxItems,maxChars){if(value==null)return[];const list=Array.isArray(value)?value:[value];return list.slice(0,maxItems).map((item)=>String(item||'').trim().slice(0,maxChars)).filter(Boolean);}
function boundedInt(value,min,max,fallback){if(value==null)return fallback;const n=Number(value);if(!Number.isFinite(n))throw new TypeError('Expected finite numeric bound.');return Math.min(max,Math.max(min,Math.floor(n)));}
function plainRecord(value){if(!value||typeof value!=='object'||Array.isArray(value))return false;const p=Object.getPrototypeOf(value);return p===Object.prototype||p===null;}
function graphError(code,message){const error=new Error(message);error.code=code;return error;}
function abortError(reason){const error=graphError('cancelled',String(reason||'cancelled'));error.name='AbortError';return error;}
function delay(ms){return new Promise((resolve)=>setTimeout(resolve,ms));}
