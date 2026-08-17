import assert from 'node:assert/strict';
import { deferred, descriptor, scheduler, waitState } from './helpers.mjs';

// Canonical priority ordering affects execution time only.
{
  const {scheduler:s}=scheduler({maxConcurrency:1,starvationInterval:8});
  const gate=deferred();
  const blocker=descriptor('priority-blocker');
  const blockerPromise=s.request({descriptor:blocker,produce:()=>gate.promise});
  await waitState(s,blocker.artifactId,'running');
  const order=[];
  const cases=[
    ['maintenance','priority-maintenance'],
    ['background','priority-background'],
    ['prefetch','priority-prefetch'],
    ['current','priority-current'],
    ['foreground','priority-foreground'],
  ];
  const promises=cases.map(([priority,id])=>s.request({descriptor:descriptor(id),priority,produce:async()=>{order.push(priority);return {semantic:'same'};}}));
  for (const [,id] of cases) await waitState(s,`artifact_${id}`,'ready');
  gate.resolve({ok:true});
  await Promise.all([blockerPromise,...promises]);
  assert.deepEqual(order,['foreground','current','prefetch','background','maintenance']);
}

// Equal requested priority at the same scheduler epoch uses ArtifactId as a stable tie-break.
{
  const {scheduler:s}=scheduler({maxConcurrency:1});
  const gate=deferred();
  const blocker=descriptor('tie-blocker');
  const blockerPromise=s.request({descriptor:blocker,produce:()=>gate.promise});
  await waitState(s,blocker.artifactId,'running');
  const order=[];
  const ids=['tie-z','tie-a','tie-m'];
  const promises=ids.map((id)=>s.request({descriptor:descriptor(id),priority:'current',produce:async()=>{order.push(`artifact_${id}`);return {};}}));
  for (const id of ids) await waitState(s,`artifact_${id}`,'ready');
  gate.resolve({}); await Promise.all([blockerPromise,...promises]);
  assert.deepEqual(order,[...ids].map((id)=>`artifact_${id}`).sort((a,b)=>a.localeCompare(b)));
}

// Starvation policy is deterministic: an old maintenance job outranks sufficiently new foreground arrivals.
{
  const {scheduler:s}=scheduler({maxConcurrency:1,starvationInterval:2});
  const gate=deferred();
  const blocker=descriptor('starvation-blocker');
  const blockerPromise=s.request({descriptor:blocker,produce:()=>gate.promise});
  await waitState(s,blocker.artifactId,'running');
  const order=[];
  const old=s.request({descriptor:descriptor('starvation-old'),priority:'maintenance',produce:async()=>{order.push('old');return {};}});
  let next=0;
  const spawned=[];
  const spawnForeground=()=>{
    const id=`starvation-fg-${String(next++).padStart(2,'0')}`;
    const promise=s.request({descriptor:descriptor(id),priority:'foreground',produce:async()=>{order.push(id);if(next<24)spawnForeground();return {};}});
    spawned.push(promise);
    return promise;
  };
  spawnForeground();
  gate.resolve({});
  await blockerPromise; await old; await Promise.all(spawned);
  const oldIndex=order.indexOf('old');
  assert.ok(oldIndex>=0&&oldIndex<16,`maintenance starved: ${JSON.stringify(order)}`);
  assert.equal(s.stats().starvationPolicy,'virtual-deadline-v1');
}

// Concurrency never exceeds the configured limit.
{
  const {scheduler:s}=scheduler({maxConcurrency:3});
  let active=0,maxActive=0;
  const promises=Array.from({length:30},(_,i)=>s.request({
    descriptor:descriptor(`concurrency-${i}`),
    produce:async()=>{active++;maxActive=Math.max(maxActive,active);await new Promise((resolve)=>setTimeout(resolve,0));active--;return {i};},
  }));
  await Promise.all(promises);
  assert.equal(maxActive,3);
  assert.equal(s.stats().maxObservedRunning,3);
}

// Priority is not ArtifactId key material and cannot change payload semantics.
{
  const desc=descriptor('priority-semantic-invariance');
  const left=scheduler();
  const right=scheduler();
  const a=await left.scheduler.request({descriptor:desc,priority:'foreground',produce:async()=>({value:42,nested:{ok:true}})});
  const b=await right.scheduler.request({descriptor:desc,priority:'maintenance',produce:async()=>({value:42,nested:{ok:true}})});
  assert.equal(a.artifactId,b.artifactId);
  assert.deepEqual(a.payload,b.payload);
}

// Deep DAG: iterative cycle traversal and dependency scheduling handle 1,000 nodes.
{
  const count=1000;
  const descriptors=[];
  for (let i=0;i<count;i++) descriptors.push(descriptor(`deep-${i}`,i?[descriptors[i-1]]:[]));
  let request={descriptor:descriptors[0],produce:async()=>({index:0})};
  for (let i=1;i<count;i++) {
    const dependency=request;
    request={descriptor:descriptors[i],dependencies:[dependency],produce:async()=>({index:i})};
  }
  const {scheduler:s}=scheduler({maxConcurrency:8});
  const result=await s.request(request);
  assert.equal(result.payload.index,count-1);
  const stats=s.stats();
  assert.equal(stats.dagNodes,count);
  assert.equal(stats.dagEdges,count-1);
  assert.equal(stats.cycleChecks,count-1);
  assert.equal(stats.producerInvocations,count);
}

// Independent queue scaling: 10 / 100 / 1,000 / 10,000 nodes remains heap-bounded, not repeated full-array sorting.
const scaling=[];
for (const count of [10,100,1000,10000]) {
  const {scheduler:s}=scheduler({maxConcurrency:64,starvationInterval:8});
  const promises=Array.from({length:count},(_,i)=>s.request({descriptor:descriptor(`scale-${count}-${String(i).padStart(5,'0')}`),priority:i%5,produce:async()=>({i})}));
  await Promise.all(promises);
  const stats=s.stats();
  assert.equal(stats.dagNodes,count);
  assert.equal(stats.dagEdges,0);
  assert.equal(stats.producerInvocations,count);
  assert.ok(stats.queueOperations<=count*2+64,`queue ops grew unexpectedly: ${JSON.stringify(stats)}`);
  const comparisonBound=Math.max(64,count*Math.max(1,Math.ceil(Math.log2(count+1)))*4);
  assert.ok(stats.queueComparisons<=comparisonBound,`heap comparisons exceeded O(N log N) guard: ${JSON.stringify(stats)}`);
  scaling.push({nodes:stats.dagNodes,edges:stats.dagEdges,queueOperations:stats.queueOperations,queueComparisons:stats.queueComparisons,producerInvocations:stats.producerInvocations,coalescedRequests:stats.coalescedRequests,cycleChecks:stats.cycleChecks,cancelledJobs:stats.cancelledJobs});
}
console.log(`phase4 scheduler scaling: ${JSON.stringify(scaling)}`);
console.log('phase4 scheduler priority/scaling: PASS');
