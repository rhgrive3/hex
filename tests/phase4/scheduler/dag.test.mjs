import assert from 'node:assert/strict';
import { SchedulerCycleError, SchedulerDependencyError, SchedulerDependencyIdentityError } from '../../../js/core/scheduler/index.js';
import { descriptor, scheduler } from './helpers.mjs';

function nodeRequest(desc, dependencies=[], counter=null) {
  return {
    descriptor:desc,
    dependencies,
    produce:async ({dependencies:results})=>{
      if (counter) counter.count++;
      return { id:desc.artifactId,dependencies:results.map((entry)=>entry.artifactId) };
    },
  };
}

// Chain.
{
  const {scheduler:s}=scheduler({maxConcurrency:4});
  const a=descriptor('chain-a');
  const b=descriptor('chain-b',[a]);
  const c=descriptor('chain-c',[b]);
  const result=await s.request(nodeRequest(c,[nodeRequest(b,[nodeRequest(a)])]));
  assert.equal(result.artifactId,c.artifactId);
  assert.deepEqual(s.dependencyIds(c.artifactId),[b.artifactId]);
  assert.equal(s.stats().dagNodes,3);
  assert.equal(s.stats().dagEdges,2);
}

// Diamond: the shared base is produced once.
{
  const {scheduler:s}=scheduler({maxConcurrency:4});
  const base=descriptor('diamond-base');
  const left=descriptor('diamond-left',[base]);
  const right=descriptor('diamond-right',[base]);
  const root=descriptor('diamond-root',[left,right]);
  const counter={count:0};
  const baseRequest=nodeRequest(base,[],counter);
  await s.request(nodeRequest(root,[nodeRequest(left,[baseRequest]),nodeRequest(right,[baseRequest])]));
  assert.equal(counter.count,1);
  assert.equal(s.stats().coalescedRequests,1);
  assert.equal(s.stats().dagEdges,4);
}

// Fan-out: one parent waits for many independent dependencies.
{
  const {scheduler:s}=scheduler({maxConcurrency:8});
  const leaves=Array.from({length:32},(_,i)=>descriptor(`fanout-${i}`));
  const root=descriptor('fanout-root',leaves);
  const result=await s.request(nodeRequest(root,leaves.map((leaf)=>nodeRequest(leaf))));
  assert.equal(result.payload.dependencies.length,32);
  assert.equal(s.stats().dagEdges,32);
}

// Fan-in: many branches share one dependency; the shared producer remains one invocation.
{
  const {scheduler:s}=scheduler({maxConcurrency:8});
  const shared=descriptor('fanin-shared');
  const counter={count:0};
  const sharedRequest=nodeRequest(shared,[],counter);
  const mids=Array.from({length:24},(_,i)=>descriptor(`fanin-mid-${i}`,[shared]));
  const root=descriptor('fanin-root',mids);
  await s.request(nodeRequest(root,mids.map((mid)=>nodeRequest(mid,[sharedRequest]))));
  assert.equal(counter.count,1);
  assert.equal(s.stats().coalescedRequests,23);
}

// Duplicate dependency declarations are coalesced to one canonical dependency.
{
  const {scheduler:s}=scheduler();
  const dep=descriptor('duplicate-dep');
  const root=descriptor('duplicate-root',[dep]);
  const counter={count:0};
  const depRequest=nodeRequest(dep,[],counter);
  const result=await s.request(nodeRequest(root,[depRequest,depRequest]));
  assert.equal(counter.count,1);
  assert.equal(result.payload.dependencies.length,1);
  assert.deepEqual(s.dependencyIds(root.artifactId),[dep.artifactId]);
}

// Missing dependency is an explicit identity failure, never implicit production.
{
  const {scheduler:s}=scheduler();
  const dep=descriptor('missing-dep');
  const root=descriptor('missing-root',[dep]);
  await assert.rejects(s.request(nodeRequest(root,[])),(error)=>error instanceof SchedulerDependencyIdentityError);
  assert.equal(s.stats().producerInvocations,0);
}

// Supplied dependency identity must match the descriptor's frozen upstream identity.
{
  const {scheduler:s}=scheduler();
  const expected=descriptor('identity-expected');
  const actual=descriptor('identity-actual');
  const root=descriptor('identity-root',[expected]);
  await assert.rejects(s.request(nodeRequest(root,[nodeRequest(actual)])),(error)=>error instanceof SchedulerDependencyIdentityError);
  assert.equal(s.stats().dependencyIdentityErrors,1);
}

// Cycle and self-cycle are explicit failures and invoke no producer.
{
  const {scheduler:s}=scheduler();
  const a={artifactId:'artifact_cycle-a',upstreamArtifactIds:['artifact_cycle-b']};
  const b={artifactId:'artifact_cycle-b',upstreamArtifactIds:['artifact_cycle-a']};
  const requestA={descriptor:a,produce:async()=>({})};
  const requestB={descriptor:b,dependencies:[requestA],produce:async()=>({})};
  requestA.dependencies=[requestB];
  await assert.rejects(s.request(requestA),(error)=>error instanceof SchedulerCycleError&&error.code==='artifact-dependency-cycle'&&error.path[0]===error.path.at(-1)&&error.path.includes('artifact_cycle-a')&&error.path.includes('artifact_cycle-b'));
  assert.equal(s.stats().producerInvocations,0);
  assert.ok(s.stats().cycleChecks>=1);
}
{
  const {scheduler:s}=scheduler();
  const self={artifactId:'artifact_self-cycle',upstreamArtifactIds:['artifact_self-cycle']};
  const request={descriptor:self,produce:async()=>({})};
  request.dependencies=[request];
  await assert.rejects(s.request(request),(error)=>error instanceof SchedulerCycleError&&error.path.join(' -> ')==='artifact_self-cycle -> artifact_self-cycle');
  assert.equal(s.stats().producerInvocations,0);
}

// Dependency producer failure is distinct and blocks parent production.
{
  const {scheduler:s}=scheduler();
  const dep=descriptor('failure-dep');
  const root=descriptor('failure-root',[dep]);
  let parentInvocations=0;
  await assert.rejects(
    s.request({descriptor:root,dependencies:[{descriptor:dep,produce:async()=>{throw new Error('dependency-boom');}}],produce:async()=>{parentInvocations++;return {};}}),
    (error)=>error instanceof SchedulerDependencyError&&error.cause?.message==='dependency-boom',
  );
  assert.equal(parentInvocations,0);
  assert.equal(s.stats().dependencyFailures,1);
}

console.log('phase4 scheduler DAG: PASS');
