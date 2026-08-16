import assert from 'node:assert/strict';
import {analyzeSemanticDominance,createSemanticCfg,deterministicTraversal,reachableBlocks} from '../../js/semantics/cfg/index.js';
const edge=(to,kind='branch')=>({to,kind});
const graph=(blocks,entryBlockId=blocks[0].id,options={})=>createSemanticCfg({functionId:'function_cfg',entryBlockId,blocks},options);
{
 const cfg=graph([{id:'entry',successors:[edge('left','conditional-true'),edge('right','conditional-false')]},{id:'left',successors:[edge('join')]},{id:'right',successors:[edge('join')]},{id:'join',successors:[]}]);const d=analyzeSemanticDominance(cfg);assert.deepEqual(d.dominators.join,['entry','join']);assert.equal(d.immediateDominators.left,'entry');assert.equal(d.immediateDominators.right,'entry');assert.equal(d.immediateDominators.join,'entry');assert.deepEqual(d.dominanceFrontier.left,['join']);assert.deepEqual(d.dominanceFrontier.right,['join']);
}
{
 const cfg=graph([{id:'entry',successors:[edge('header')]},{id:'header',successors:[edge('body','conditional-true'),edge('exit','conditional-false')]},{id:'body',successors:[edge('header')]},{id:'exit',successors:[]}]);const d=analyzeSemanticDominance(cfg);assert.equal(d.immediateDominators.body,'header');assert.deepEqual(d.dominanceFrontier.body,['header']);assert.ok(d.dominanceFrontier.header.includes('header'));
}
{
 const cfg=graph([{id:'entry',successors:[edge('outer')]},{id:'outer',successors:[edge('inner'),edge('done')]},{id:'inner',successors:[edge('innerBody'),edge('outerLatch')]},{id:'innerBody',successors:[edge('inner')]},{id:'outerLatch',successors:[edge('outer')]},{id:'done',successors:[]}]);const d=analyzeSemanticDominance(cfg);assert.equal(d.immediateDominators.innerBody,'inner');assert.equal(d.immediateDominators.outerLatch,'inner');assert.ok(d.dominanceFrontier.innerBody.includes('inner'));assert.ok(d.dominanceFrontier.outerLatch.includes('outer'));
}
{
 const cfg=graph([{id:'entry',successors:[edge('a')]},{id:'a',successors:[edge('exit1'),edge('exit2')]},{id:'exit1',successors:[]},{id:'exit2',successors:[]},{id:'unreachable',successors:[]}]);assert.deepEqual(reachableBlocks(cfg),['a','entry','exit1','exit2']);assert.ok(deterministicTraversal(cfg).includes('unreachable'));const d=analyzeSemanticDominance(cfg);assert.deepEqual(d.dominators.unreachable,['unreachable']);assert.equal(d.immediateDominators.unreachable,null);
}
{
 const cfg=graph([{id:'entry',successors:[edge('a'),edge('b')]},{id:'a',successors:[edge('c')]},{id:'b',successors:[edge('c')]},{id:'c',successors:[edge('a'),edge('b'),edge('exit')]},{id:'exit',successors:[]}]);const d=analyzeSemanticDominance(cfg);assert.equal(d.immediateDominators.c,'entry');assert.ok(d.dominanceFrontier.a.includes('c'));assert.ok(d.dominanceFrontier.b.includes('c'));
}
{
 const a=graph([{id:'entry',successors:[edge('z'),edge('a')]},{id:'z',successors:[edge('exit')]},{id:'a',successors:[edge('exit')]},{id:'exit',successors:[]}]);const b=graph([{id:'exit',successors:[]},{id:'a',successors:[edge('exit')]},{id:'entry',successors:[edge('a'),edge('z')]},{id:'z',successors:[edge('exit')]}],'entry');assert.deepEqual(deterministicTraversal(a),deterministicTraversal(b));assert.deepEqual(analyzeSemanticDominance(a),analyzeSemanticDominance(b));
}
assert.throws(()=>graph([{id:'entry',successors:[edge('missing')]}]),/invalid-successor/);
assert.throws(()=>graph([{id:'entry',successors:[edge('exit')]},{id:'exit',predecessors:['wrong'],successors:[]}]),/predecessor-mismatch/);
assert.throws(()=>graph([{id:'entry',successors:[]},{id:'entry',successors:[]}]),/duplicate-block-id/);
{
 const controller=new AbortController();controller.abort();assert.throws(()=>graph([{id:'entry',successors:[]}],'entry',{signal:controller.signal}),/cancelled/);
}
assert.throws(()=>createSemanticCfg({functionId:'function_cfg',entryBlockId:'entry',blocks:[{id:'entry',successors:[edge('exit')]},{id:'exit',successors:[]}]},{budget:{maxBlocks:1,maxEdges:1}}),/budget-exceeded-maxBlocks/);
console.log('semantic-v2 CFG contracts: PASS');
