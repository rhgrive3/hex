import { BudgetExceededError } from '../budgets/index.js';
import { createSchedulerBudget } from '../budgets/scheduler-budget.js';
import {
  ANALYSIS_PRIORITY,
  ANALYSIS_SCHEDULER_VERSION,
  SchedulerCycleError,
  SchedulerDependencyError,
  SchedulerDependencyIdentityError,
} from './index.js';

export {
  ANALYSIS_PRIORITY,
  ANALYSIS_SCHEDULER_VERSION,
  SchedulerCycleError,
  SchedulerDependencyError,
  SchedulerDependencyIdentityError,
};

function priorityValue(value) {
  if (typeof value === 'string' && Object.hasOwn(ANALYSIS_PRIORITY, value)) return ANALYSIS_PRIORITY[value];
  const n = Number(value ?? ANALYSIS_PRIORITY.current);
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('analysis-priority-invalid');
  return n;
}
function abortError(signal) { return signal?.reason || new DOMException('Aborted', 'AbortError'); }
function sameStrings(a, b) { return a.length === b.length && a.every((value, index) => value === b[index]); }
function canonicalDependencies(request, artifactId) {
  const supplied = Array.isArray(request.dependencies) ? request.dependencies : [];
  const byId = new Map();
  for (const dependency of supplied) {
    const id = String(dependency?.descriptor?.artifactId || '');
    if (!id) throw new SchedulerDependencyIdentityError(artifactId, request.descriptor?.upstreamArtifactIds || [], ['<missing-artifact-id>']);
    if (!byId.has(id)) byId.set(id, dependency);
  }
  const dependencies = [...byId.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, dependency]) => dependency);
  const actual = dependencies.map((dependency) => String(dependency.descriptor.artifactId));
  const expected = [...(request.descriptor?.upstreamArtifactIds || [])].map(String).sort();
  if (!sameStrings(expected, actual)) throw new SchedulerDependencyIdentityError(artifactId, expected, actual);
  return dependencies;
}
function uniqueSignals(...values) {
  const out=[];
  for (const value of values.flat()) if (value && !out.includes(value)) out.push(value);
  return out;
}
function isStorageFailure(error) { return error?.name === 'ArtifactStorageError' || String(error?.code || '').startsWith('artifact-storage-'); }

class IndexedMinHeap {
  constructor(compare) { this.items=[]; this.indices=new Map(); this.compareFn=compare; this.comparisons=0; }
  get size() { return this.items.length; }
  #compare(a,b) { this.comparisons++; return this.compareFn(a,b); }
  #swap(a,b) { const x=this.items[a],y=this.items[b]; this.items[a]=y; this.items[b]=x; this.indices.set(y.artifactId,a); this.indices.set(x.artifactId,b); }
  #up(index) { while (index>0) { const parent=(index-1)>>1; if (this.#compare(this.items[index],this.items[parent])>=0) break; this.#swap(index,parent); index=parent; } }
  #down(index) { for (;;) { let best=index; const left=index*2+1,right=left+1; if (left<this.items.length&&this.#compare(this.items[left],this.items[best])<0) best=left; if (right<this.items.length&&this.#compare(this.items[right],this.items[best])<0) best=right; if (best===index) break; this.#swap(index,best); index=best; } }
  push(item) { if (this.indices.has(item.artifactId)) throw new Error('scheduler-queue-duplicate'); const index=this.items.length; this.items.push(item); this.indices.set(item.artifactId,index); this.#up(index); }
  pop() { if (!this.items.length) return null; const root=this.items[0]; this.remove(root.artifactId); return root; }
  remove(artifactId) { const index=this.indices.get(String(artifactId)); if (index==null) return null; const removed=this.items[index]; const last=this.items.pop(); this.indices.delete(removed.artifactId); if (index<this.items.length) { this.items[index]=last; this.indices.set(last.artifactId,index); this.#up(index); this.#down(this.indices.get(last.artifactId)); } return removed; }
}

function priorityName(value) {
  for (const [k, v] of Object.entries(ANALYSIS_PRIORITY)) {
    if (v === value) return k;
  }
  return typeof value === 'string' ? value : 'current';
}

export class AnalysisScheduler {
  constructor({ store, maxConcurrency=2, starvationInterval=8, defaultBudget={}, onEvent=null }={}) {
    if (!store) throw new TypeError('artifact-store-required');
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency <= 0) throw new TypeError('scheduler-max-concurrency-invalid');
    if (!Number.isSafeInteger(Number(starvationInterval)) || Number(starvationInterval) <= 0) throw new TypeError('scheduler-starvation-interval-invalid');
    this.store=store; this.maxConcurrency=maxConcurrency; this.starvationInterval=Number(starvationInterval); this.defaultBudget=defaultBudget;
    this.onEvent = typeof onEvent === 'function' ? onEvent : null;
    this.seq = 0;
    this.inflight=new Map(); this.running=0; this.dispatchEpoch=0; this.dag=new Map(); this.dagEdgeCount=0; this.states=new Map(); this.activeConsumers=0;
    this.queue=new IndexedMinHeap((a,b)=>a.orderKey<b.orderKey?-1:a.orderKey>b.orderKey?1:a.artifactId.localeCompare(b.artifactId));
    this.metrics={ requests:0,cacheHits:0,producerInvocations:0,coalescedRequests:0,queueOperations:0,completedJobs:0,failedJobs:0,cancelledJobs:0,cancelledConsumers:0,orphanCancellations:0,budgetExhaustions:0,dependencyFailures:0,producerFailures:0,storageFailures:0,cycleErrors:0,cycleChecks:0,cycleTraversalSteps:0,dependencyIdentityErrors:0,maxObservedRunning:0,observerFailures:0 };
  }

  #emit(type, taskOrArtifactId, details = {}) {
    if (!this.onEvent) return;
    try {
      const artifactId = typeof taskOrArtifactId === 'string' ? taskOrArtifactId : taskOrArtifactId?.artifactId;
      const state = typeof taskOrArtifactId === 'object' && taskOrArtifactId?.state != null
        ? taskOrArtifactId.state
        : (this.states.get(artifactId) ?? null);
      const event = Object.freeze({
        seq: ++this.seq,
        type,
        artifactId,
        state,
        details: Object.freeze({ ...details }),
      });
      this.onEvent(event);
    } catch {
      this.metrics.observerFailures = (this.metrics.observerFailures || 0) + 1;
    }
  }

  request(request) { return this.#request(request,[],null); }

  #request(request, ancestry, parentSignal) {
    const descriptor=request?.descriptor;
    const artifactId=String(descriptor?.artifactId||'');
    if (!artifactId) return Promise.reject(new TypeError('artifact-request-descriptor-required'));
    this.metrics.requests++;
    const priority = priorityValue(request.priority);
    this.#emit('request.received', artifactId, {
      priority: priorityName(priority),
      dependencyCount: (descriptor?.upstreamArtifactIds || []).length,
    });
    const consumerSignals=uniqueSignals(request.signal,parentSignal);
    const alreadyAborted=consumerSignals.find((signal)=>signal.aborted);
    if (alreadyAborted) { this.metrics.cancelledConsumers++; return Promise.reject(abortError(alreadyAborted)); }
    if (ancestry.includes(artifactId)) { this.metrics.cycleErrors++; return Promise.reject(new SchedulerCycleError([...ancestry,artifactId])); }
    const existing=this.inflight.get(artifactId);
    if (existing) {
      this.metrics.coalescedRequests++;
      const p = this.#attachConsumer(existing,consumerSignals);
      this.#emit('request.coalesced', existing, { consumerCount: existing.consumerCount });
      return p;
    }

    const controller=new AbortController();
    const task={ artifactId,descriptor,request,controller,priority,enqueuedEpoch:null,orderKey:null,state:'waiting-dependency',phase:'dependency',queueResolve:null,queueReject:null,promise:null,settled:false,consumerCount:0 };
    controller.signal.addEventListener('abort',()=>this.#cancelQueuedTask(task),{once:true});
    task.promise=Promise.resolve()
      .then(()=>this.#execute(task,[...ancestry,artifactId]))
      .catch((error)=>{ this.#recordFailure(task,error); throw error; })
      .finally(()=>{ task.settled=true; if (this.inflight.get(artifactId)===task) this.inflight.delete(artifactId); });
    this.inflight.set(artifactId,task);
    return this.#attachConsumer(task,consumerSignals);
  }

  #attachConsumer(task, signals) {
    const active=uniqueSignals(signals,task.controller.signal);
    const aborted=active.find((signal)=>signal.aborted);
    if (aborted) { this.metrics.cancelledConsumers++; return Promise.reject(abortError(aborted)); }
    task.consumerCount++; this.activeConsumers++;
    return new Promise((resolve,reject)=>{
      let settled=false;
      const listeners=[];
      const finish=(fn,value,cancelled=false)=>{
        if (settled) return;
        settled=true;
        for (const [signal,listener] of listeners) signal.removeEventListener('abort',listener);
        task.consumerCount--; this.activeConsumers--;
        if (cancelled) {
          this.metrics.cancelledConsumers++;
          if (task.consumerCount===0&&!task.settled&&!task.controller.signal.aborted) {
            this.metrics.orphanCancellations++;
            task.controller.abort(new DOMException('No active consumers','AbortError'));
          }
        }
        fn(value);
      };
      for (const signal of active) {
        const listener=()=>finish(reject,abortError(signal),true);
        listeners.push([signal,listener]); signal.addEventListener('abort',listener,{once:true});
      }
      task.promise.then((value)=>finish(resolve,value),(error)=>finish(reject,error));
    });
  }

  async #execute(task, ancestry) {
    let dependencies;
    try { dependencies=canonicalDependencies(task.request,task.artifactId); }
    catch (error) { if (error instanceof SchedulerDependencyIdentityError) this.metrics.dependencyIdentityErrors++; throw error; }
    this.#registerDag(task.artifactId,dependencies.map((dependency)=>String(dependency.descriptor.artifactId)));
    this.states.set(task.artifactId,'waiting-dependency');
    const dependencyResults=await this.#waitForDependencies(task,dependencies,ancestry);
    if (task.controller.signal.aborted) throw abortError(task.controller.signal);

    task.phase='cache';
    const cached=await this.store.get(task.descriptor,{signal:task.controller.signal});
    if (cached.status==='hit') {
      this.metrics.cacheHits++;
      this.states.set(task.artifactId,'completed');
      this.#emit('cache.hit', task, { source:'store' });
      return {...cached,state:'completed',reused:true};
    }
    if (task.controller.signal.aborted) throw abortError(task.controller.signal);
    return this.#enqueue(task,dependencyResults);
  }

  async #waitForDependencies(task, dependencies, ancestry) {
    if (!dependencies.length) return [];
    const waitController=new AbortController();
    const onParentAbort=()=>waitController.abort(abortError(task.controller.signal));
    if (task.controller.signal.aborted) onParentAbort(); else task.controller.signal.addEventListener('abort',onParentAbort,{once:true});
    const promises=dependencies.map((dependency)=>this.#request(dependency,ancestry,waitController.signal));
    try { return await Promise.all(promises); }
    catch (error) {
      if (task.controller.signal.aborted) throw abortError(task.controller.signal);
      if (!waitController.signal.aborted) waitController.abort(new DOMException('Dependency wait cancelled','AbortError'));
      await Promise.allSettled(promises);
      if (error instanceof SchedulerCycleError || error instanceof SchedulerDependencyIdentityError) throw error;
      this.metrics.dependencyFailures++;
      throw new SchedulerDependencyError(task.artifactId,error);
    } finally { task.controller.signal.removeEventListener('abort',onParentAbort); }
  }

  #registerDag(artifactId, dependencyIds) {
    const ids=[...dependencyIds].sort((a,b)=>a.localeCompare(b));
    for (const dependencyId of ids) {
      this.metrics.cycleChecks++;
      if (dependencyId===artifactId) { this.metrics.cycleErrors++; throw new SchedulerCycleError([artifactId,artifactId]); }
      const path=this.#pathBetween(dependencyId,artifactId);
      if (path) { this.metrics.cycleErrors++; throw new SchedulerCycleError([artifactId,...path]); }
    }
    const previous=this.dag.get(artifactId)||[];
    this.dagEdgeCount+=ids.length-previous.length;
    this.dag.set(artifactId,Object.freeze(ids));
    for (const dependencyId of ids) if (!this.dag.has(dependencyId)) this.dag.set(dependencyId,Object.freeze([]));
  }

  #pathBetween(start,target) {
    const stack=[start];
    const parent=new Map([[start,null]]);
    while (stack.length) {
      const current=stack.pop();
      this.metrics.cycleTraversalSteps++;
      if (current===target) {
        const path=[];
        for (let node=current;node!=null;node=parent.get(node)) path.push(node);
        path.reverse();
        return path;
      }
      const next=this.dag.get(current)||[];
      for (let i=next.length-1;i>=0;i--) {
        const child=next[i];
        if (parent.has(child)) continue;
        parent.set(child,current);
        stack.push(child);
      }
    }
    return null;
  }

  #enqueue(task,dependencyResults) {
    return new Promise((resolve,reject)=>{
      if (task.controller.signal.aborted) { reject(abortError(task.controller.signal)); return; }
      task.queueResolve=resolve; task.queueReject=reject; task.dependencyResults=dependencyResults; task.state='ready'; task.phase='ready'; task.enqueuedEpoch=this.dispatchEpoch;
      task.orderKey=BigInt(task.enqueuedEpoch)+(BigInt(task.priority)*BigInt(this.starvationInterval));
      this.states.set(task.artifactId,'ready'); this.queue.push(task); this.metrics.queueOperations++;
      this.#emit('queue.enqueued', task, { priority: priorityName(task.priority) });
      this.#pump();
    });
  }

  #pump() {
    while (this.running<this.maxConcurrency&&this.queue.size) {
      const task=this.queue.pop(); this.metrics.queueOperations++; this.dispatchEpoch++;
      if (task.controller.signal.aborted) { task.queueReject(abortError(task.controller.signal)); continue; }
      this.running++; this.metrics.maxObservedRunning=Math.max(this.metrics.maxObservedRunning,this.running); task.state='running'; task.phase='producer'; this.states.set(task.artifactId,'running');
      this.#emit('job.started', task, { priority: priorityName(task.priority) });
      this.#run(task).then(task.queueResolve,task.queueReject).finally(()=>{ this.running--; this.#pump(); });
    }
  }

  async #run(task) {
    const signal=task.controller.signal;
    const budget=createSchedulerBudget(task.request.budget,this.defaultBudget,signal);
    budget.checkCancelled();
    if (typeof task.request.produce!=='function') throw new TypeError('artifact-producer-required');
    this.metrics.producerInvocations++;
    task.phase='producer';
    const payload=await task.request.produce({ descriptor:task.descriptor,artifactId:task.artifactId,dependencies:task.dependencyResults,signal,budget });
    budget.checkCancelled();
    task.phase='publish';
    const published=await this.store.publish(task.descriptor,payload,{ signal,completeness:task.request.completeness??'complete',validate:task.request.validate,creation:task.request.creation });
    budget.checkCancelled(); this.metrics.completedJobs++; this.states.set(task.artifactId,'completed'); task.phase='completed';
    this.#emit('job.completed', task, { published: true });
    return {...published,state:'completed',reused:false,budget:budget.snapshot()};
  }

  #recordFailure(task,error) {
    if (error instanceof BudgetExceededError) {
      this.metrics.budgetExhaustions++;
      this.states.set(task.artifactId,'budget-exhausted');
      this.#emit('budget.exhausted', task, {
        resource: error.resource ?? null,
        limit: error.limit ?? null,
        requested: error.used ?? error.requested ?? null,
      });
      return;
    }
    if (task.controller.signal.aborted||error?.name==='AbortError') {
      this.metrics.cancelledJobs++;
      this.states.set(task.artifactId,'cancelled');
      const phase = task.phase === 'producer' ? 'running' : (task.state === 'ready' || task.phase === 'ready') ? 'queued' : 'waiting-dependency';
      this.#emit('job.cancelled', task, { phase });
      return;
    }
    if (error instanceof SchedulerDependencyError) {
      this.metrics.failedJobs++;
      this.states.set(task.artifactId,'failed');
      this.#emit('dependency.failed', task, {
        dependencyArtifactId: error.cause?.artifactId || error.artifactId || null,
      });
      return;
    }
    if (task.phase==='cache'||task.phase==='publish'||isStorageFailure(error)) {
      this.metrics.failedJobs++;
      this.metrics.storageFailures++;
      this.states.set(task.artifactId,'failed');
      this.#emit('storage.failed', task, { code: error.code || null });
      return;
    }
    this.metrics.failedJobs++;
    if (task.phase==='producer') this.metrics.producerFailures++;
    this.states.set(task.artifactId,'failed');
    this.#emit('job.failed', task, { code: error.code || null, name: error.name || 'Error' });
  }

  #cancelQueuedTask(task) {
    if (task.state!=='ready') return;
    const removed=this.queue.remove(task.artifactId);
    if (!removed) return;
    this.metrics.queueOperations++;
    task.queueReject(abortError(task.controller.signal));
  }

  cancel(artifactId, reason=new DOMException('Cancelled','AbortError')) {
    const task=this.inflight.get(String(artifactId)); if (!task) return false;
    if (!task.controller.signal.aborted) task.controller.abort(reason);
    return true;
  }

  dependencyIds(artifactId) { return this.dag.get(String(artifactId))||Object.freeze([]); }
  state(artifactId) { return this.states.get(String(artifactId))||'unknown'; }
  stats() { return Object.freeze({ schedulerVersion:ANALYSIS_SCHEDULER_VERSION,starvationPolicy:'virtual-deadline-v1',starvationInterval:this.starvationInterval,running:this.running,queued:this.queue.size,inflight:this.inflight.size,activeConsumers:this.activeConsumers,dagNodes:this.dag.size,dagEdges:this.dagEdgeCount,queueComparisons:this.queue.comparisons,producerInvocationCount:this.metrics.producerInvocations,...this.metrics }); }
}
