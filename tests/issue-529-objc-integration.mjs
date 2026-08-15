import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mergeObjcRuntimeMetadata, resolveObjcDispatch } from '../js/objc.js';

const base={
  classes:[{name:'PlayerData',addr:0x1000n,methods:[{selector:'save:',imp:0x1100n,typeEncoding:'v24@0:8@16'}],classMethods:[]}],
  names:[{addr:0x1100n,name:'-[PlayerData save:]'}], warnings:[],
};
const extended={
  categories:[{name:'Debug',className:'PlayerData',instanceMethods:[{selector:'debugName',imp:0x1200n,typeEncoding:'@16@0:8'}],classMethods:[],protocols:['Trackable']}],
  protocols:[{name:'Trackable',requiredInstanceMethods:[],optionalInstanceMethods:[{selector:'track:',typeEncoding:'v24@0:8@16'}],requiredClassMethods:[],optionalClassMethods:[]}],
};
const model=mergeObjcRuntimeMetadata(structuredClone(base),extended);
assert.equal(model.categories.length,1);
assert.equal(model.protocols.length,1);
assert.ok(model.names.some((x)=>x.addr===0x1200n&&x.name==='-[PlayerData(Debug) debugName]'));
const category=resolveObjcDispatch(model.runtimeIndex,'PlayerData','debugName','instance');
assert.equal(category.resolved,true);
assert.equal(category.candidates[0].typeEncoding,'@16@0:8');
assert.equal(category.candidates[0].source,'category');
const protocol=resolveObjcDispatch(model.runtimeIndex,'PlayerData','track:','instance');
assert.equal(protocol.resolved,true);
assert.ok(protocol.candidates.some((x)=>x.source==='protocol'&&x.typeEncoding==='v24@0:8@16'));

const objcSource=await readFile(new URL('../js/objc.js',import.meta.url),'utf8');
assert.match(objcSource,/parseObjcExtendedMetadata\(read, sections, base\.classes/);
const appSource=await readFile(new URL('../js/app.js',import.meta.url),'utf8');
assert.match(appSource,/section === '__objc_protolist'/);
assert.match(appSource,/section === '__objc_catlist'/);
assert.match(appSource,/this\.objcRuntime = model\.runtimeIndex/);
const toolsSource=await readFile(new URL('../js/tools.js',import.meta.url),'utf8');
assert.match(toolsSource,/await app\.ensureObjc/);
assert.match(toolsSource,/objcModel: app\.objcModel \|\| null/);
const ctxSource=await readFile(new URL('../js/ai/ui/hex-context.js',import.meta.url),'utf8');
assert.match(ctxSource,/async resolveObjcDispatch\(/);
assert.match(ctxSource,/await app\.ensureObjc/);
const registrySource=await readFile(new URL('../js/ai/tools/registry.js',import.meta.url),'utf8');
assert.match(registrySource,/register\('resolve_objc_dispatch'/);
assert.doesNotMatch(toolsSource,/appleRuntime: app\.objcModel \?/,'normal decompiler must let runtimeFromOpts build the canonical mixed index');

// Non-Apple guard remains section-driven: no ObjC sections means no parser invocation path.
assert.match(appSource,/if \(!list && !protocolList && !categoryList\)/);

console.log('issue #529 ObjC runtime integration: PASS');
