import assert from 'node:assert/strict';
import { BudgetExceededError, ResourceBudget } from '../../../js/core/budgets/index.js';
import { SchedulerDependencyError } from '../../../js/core/scheduler/index.js';
import { deferred, delay, descriptor, scheduler, TestStore, waitState } from './helpers.mjs';

// Cancel before enqueue: no task and no producer.
{
  const {store,scheduler:s}=scheduler();
  const controller=new AbortController(); controller.abort(new DOMException('pre-cancel','AbortError'));
  let invocations=0;
  await assert.rejects(s.request({descriptor:descriptor('cancel-before'),signal:controller.signal,produce:async()=>{invocations++;return {};}}),(error)=>error?.name==='AbortError');
  assert.equal(invocations,0);
  assert.equal(store.entries.size,0);
}

// Cancel while queued behind a running producer.
{
  const {store,scheduler:s}=scheduler({maxConcurrency:1});
  const gate=deferred();
  const blocker=descriptor('queued-blocker');
  const target=descriptor('queued-target');
  const blockerPromise=s.request({descriptor:blocker,produce:()=>gate.promise});
  await waitState(s,blocker.artifactId,'running');
  const controller=new AbortController();
  let invocations=0;
  const targetPromise=s.request({descriptor:target,signal:controller.signal,produce:async()=>{invocations++;return {partial:true};}});
  await waitState(s,target.artifactId,'ready');
  controller.abort(new DOMException('queued-cancel','AbortError'));
  await assert.rejects(targetPromise,(error)=>error?.name==='AbortError');
  gate.resolve({ok:true}); await blockerPromise;
  assert.equal(invocations,0);
  assert.equal(store.entries.has(target.artifactId),false);
  assert.equal(s.state(target.artifactId),'cancelled');
}

// Cancel while waiting on a dependency; an orphan dependency receives shared cancellation.
{
  const {store,scheduler:s}=scheduler({maxConcurrency:2});
  const dep=descriptor('waiting-dep');
  const root=descriptor('waiting-root',[dep]);
  const controller=new AbortController();
  let dependencyAborted=false, parentInvocations=0;
  const promise=s.request({
    descriptor:root,signal:controller.signal,
    dependencies:[{descriptor:dep,produce:({signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{dependencyAborted=true;reject(signal.reason);},{once:true}))}],
    produce:async()=>{parentInvocations++;return {};},
  });
  await waitState(s,dep.artifactId,'running');
  controller.abort(new DOMException('parent-cancel','AbortError'));
  await assert.rejects(promise,(error)=>error?.name==='AbortError');
  for (let i=0;i<20&&!dependencyAborted;i++) await delay(0);
  assert.equal(dependencyAborted,true);
  assert.equal(parentInvocations,0);
  assert.equal(store.entries.has(root.artifactId),false);
}

// Cancel a running producer; cooperative work stops and cannot publish a partial artifact.
{
  const {store,scheduler:s}=scheduler({maxConcurrency:1});
  const target=descriptor('running-cancel');
  const controller=new AbortController();
  let work=0;
  const promise=s.request({
    descriptor:target,signal:controller.signal,
    produce:async({signal,budget})=>{
      for (let i=0;i<100;i++) {
        await delay(0);
        budget.consume('workUnits',1);
        if (signal.aborted) throw signal.reason;
        work++;
        if (i===2) controller.abort(new DOMException('running-cancel','AbortError'));
      }
      return {partial:true};
    },
  });
  await assert.rejects(promise,(error)=>error?.name==='AbortError');
  const stoppedAt=work; await delay(5);
  assert.equal(work,stoppedAt);
  assert.equal(store.entries.has(target.artifactId),false);
}

// Cancel after dependency success but before parent execution.
{
  const {store,scheduler:s}=scheduler({maxConcurrency:1});
  const dep=descriptor('after-success-dep');
  await s.request({descriptor:dep,produce:async()=>({ready:true})});
  const gate=deferred();
  const blocker=descriptor('after-success-blocker');
  const blockerPromise=s.request({descriptor:blocker,produce:()=>gate.promise});
  await waitState(s,blocker.artifactId,'running');
  const root=descriptor('after-success-root',[dep]);
  const controller=new AbortController();
  let parentInvocations=0;
  const promise=s.request({descriptor:root,signal:controller.signal,dependencies:[{descriptor:dep,produce:async()=>assert.fail('cached dependency reran')}],produce:async()=>{parentInvocations++;return {};}});
  await waitState(s,root.artifactId,'ready');
  controller.abort(new DOMException('after-dependency','AbortError'));
  await assert.rejects(promise,(error)=>error?.name==='AbortError');
  gate.resolve({ok:true}); await blockerPromise;
  assert.equal(parentInvocations,0);
  assert.equal(store.entries.has(root.artifactId),false);
}

// One cancelled consumer does not corrupt 99 valid consumers of one shared producer.
{
  const {scheduler:s}=scheduler({maxConcurrency:2});
  const target=descriptor('coalesced-one-cancel');
  const gate=deferred();
  let invocations=0;
  const controllers=Array.from({length:100},()=>new AbortController());
  const promises=controllers.map((controller)=>s.request({descriptor:target,signal:controller.signal,produce:async({signal})=>{invocations++;await gate.promise;if(signal.aborted)throw signal.reason;return {ok:true};}}));
  controllers[0].abort(new DOMException('only-one','AbortError'));
  await assert.rejects(promises[0],(error)=>error?.name==='AbortError');
  gate.resolve();
  const results=await Promise.all(promises.slice(1));
  assert.equal(results.length,99);
  assert.equal(invocations,1);
  assert.equal(s.stats().producerInvocationCount,1);
  assert.equal(s.stats().coalescedRequests,99);
}

// Cancelling every coalesced consumer aborts the now-orphaned shared producer.
{
  const {store,scheduler:s}=scheduler({maxConcurrency:1});
  const target=descriptor('coalesced-all-cancel');
  let producerSawAbort=false;
  const controllers=Array.from({length:16},()=>new AbortController());
  const promises=controllers.map((controller)=>s.request({
    descriptor:target,signal:controller.signal,
    produce:({signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{producerSawAbort=true;reject(signal.reason);},{once:true})),
  }));
  await waitState(s,target.artifactId,'running');
  controllers.forEach((controller)=>controller.abort(new DOMException('all-cancel','AbortError')));
  const results=await Promise.allSettled(promises);
  assert.ok(results.every((entry)=>entry.status==='rejected'&&entry.reason?.name==='AbortError'));
  for (let i=0;i<20&&!producerSawAbort;i++) await delay(0);
  assert.equal(producerSawAbort,true);
  assert.equal(store.entries.has(target.artifactId),false);
  assert.equal(s.stats().producerInvocationCount,1);
}

// Cancelling a dependency is a dependency failure for the parent, not parent AbortError.
{
  const {scheduler:s}=scheduler({maxConcurrency:2});
  const dep=descriptor('dependency-cancel-dep');
  const root=descriptor('dependency-cancel-root',[dep]);
  let parentInvocations=0;
  const promise=s.request({
    descriptor:root,
    dependencies:[{descriptor:dep,produce:({signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}],
    produce:async()=>{parentInvocations++;return {};},
  });
  await waitState(s,dep.artifactId,'running');
  assert.equal(s.cancel(dep.artifactId),true);
  await assert.rejects(promise,(error)=>error instanceof SchedulerDependencyError&&error.cause?.name==='AbortError');
  assert.equal(parentInvocations,0);
  assert.equal(s.state(root.artifactId),'failed');
}

// Work-unit, node and byte budgets remain typed BudgetExceededError failures.
for (const [resource,limit,amount] of [['workUnits',1,2],['nodes',3,4],['bytes',5,6]]) {
  const {store,scheduler:s}=scheduler();
  const target=descriptor(`budget-${resource}`);
  await assert.rejects(
    s.request({descriptor:target,budget:{[resource]:limit},produce:async({budget})=>{budget.consume(resource,amount);return {partial:true};}}),
    (error)=>error instanceof BudgetExceededError&&error.code==='budget-exhausted'&&error.resource===resource,
  );
  assert.equal(store.entries.has(target.artifactId),false);
  assert.equal(s.state(target.artifactId),'budget-exhausted');
}

// A caller-supplied ResourceBudget shares accounting but gains scheduler cancellation.
{
  const {scheduler:s}=scheduler();
  const controller=new AbortController();
  const budget=new ResourceBudget({workUnits:10});
  let sawAbort=false;
  const promise=s.request({
    descriptor:descriptor('budget-bound-signal'),signal:controller.signal,budget,
    produce:async({budget:boundBudget})=>{
      controller.abort(new DOMException('budget-bound','AbortError'));
      try { boundBudget.consume('workUnits',1); }
      catch (error) { sawAbort=error?.name==='AbortError'; throw error; }
      return {};
    },
  });
  await assert.rejects(promise,(error)=>error?.name==='AbortError');
  assert.equal(sawAbort,true);
  assert.equal(budget.snapshot().used.workUnits,undefined);
}

// Producer and storage failures stay distinct from budget, abort and dependency failures.
{
  const {scheduler:s}=scheduler();
  const error=await s.request({descriptor:descriptor('producer-failure'),produce:async()=>{throw new Error('producer-failure');}}).catch((caught)=>caught);
  assert.equal(error.message,'producer-failure');
  assert.equal(error instanceof BudgetExceededError,false);
  assert.equal(error instanceof SchedulerDependencyError,false);
  assert.notEqual(error.name,'AbortError');
  assert.equal(s.stats().producerFailures,1);
}
{
  class FailingStore extends TestStore {
    async publish() { const error=new Error('storage-failure'); error.name='ArtifactStorageError'; error.code='artifact-storage-failure'; throw error; }
  }
  const store=new FailingStore();
  const {scheduler:s}=scheduler({store});
  const error=await s.request({descriptor:descriptor('storage-failure'),produce:async()=>({ok:true})}).catch((caught)=>caught);
  assert.equal(error.name,'ArtifactStorageError');
  assert.equal(error instanceof BudgetExceededError,false);
  assert.equal(error instanceof SchedulerDependencyError,false);
  assert.notEqual(error.name,'AbortError');
  assert.equal(s.stats().storageFailures,1);
}

console.log('phase4 scheduler cancellation/budget: PASS');
