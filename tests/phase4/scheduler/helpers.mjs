import assert from 'node:assert/strict';
import { AnalysisScheduler } from '../../../js/core/scheduler/analysis-scheduler.js';

export class TestStore {
  constructor() { this.entries=new Map(); this.publishes=0; this.gets=0; }
  async get(descriptor,{signal}={}) {
    this.gets++;
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted','AbortError');
    if (!this.entries.has(descriptor.artifactId)) return { status:'miss',source:'memory',artifactId:descriptor.artifactId };
    return { status:'hit',source:'memory',artifactId:descriptor.artifactId,payload:this.entries.get(descriptor.artifactId) };
  }
  async publish(descriptor,payload,{signal}={}) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted','AbortError');
    await Promise.resolve();
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted','AbortError');
    this.entries.set(descriptor.artifactId,payload); this.publishes++;
    return { status:'published',artifactId:descriptor.artifactId,payload };
  }
  async delete(artifactId) { return this.entries.delete(String(artifactId)); }
}

export function descriptor(name, dependencies=[]) {
  const artifactId=String(name).startsWith('artifact_')?String(name):`artifact_${name}`;
  const upstreamArtifactIds=[...new Set(dependencies.map((item)=>typeof item==='string'?item:item.artifactId))].sort((a,b)=>a.localeCompare(b));
  return Object.freeze({ artifactId,upstreamArtifactIds });
}
export function scheduler(options={}) { const store=options.store||new TestStore(); return {store,scheduler:new AnalysisScheduler({store,...options})}; }
export function deferred() { let resolve,reject; const promise=new Promise((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; }
export function delay(ms=0) { return new Promise((resolve)=>setTimeout(resolve,ms)); }
export async function waitState(scheduler,artifactId,state,turns=1000) {
  for (let i=0;i<turns;i++) { if (scheduler.state(artifactId)===state) return; await Promise.resolve(); }
  assert.fail(`state ${state} not reached for ${artifactId}; got ${scheduler.state(artifactId)}`);
}
