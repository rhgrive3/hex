import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildObjcRuntimeIndex, resolveObjcDispatch } from '../js/objc.js';
import { createHexToolRegistry } from '../js/ai/tools/registry.js';

const complete = {
  protocols: { present: true, complete: true },
  categories: { present: true, complete: true },
  complete: true,
};
const model = {
  runtime: 'objc',
  runtimeCompleteness: complete,
  classes: [
    {
      name: 'PlayerData', addr: 0x1000n, superName: null, protocols: [],
      methods: [
        { selector: 'save:', imp: 0x1100n, types: 'v24@0:8@16' },
        { selector: 'baseOnly', imp: 0x1110n, types: 'q16@0:8' },
      ],
      classMethods: [],
    },
    { name: 'ChildData', addr: 0x1010n, superName: 'PlayerData', protocols: [], methods: [], classMethods: [] },
    { name: 'OtherData', addr: 0x1020n, superName: null, protocols: [], methods: [{ selector: 'debugName', imp: 0x2100n, types: '@16@0:8' }], classMethods: [] },
  ],
  categories: [{
    name: 'Debug', className: 'PlayerData', protocols: [{ name: 'Trackable' }],
    instanceMethods: [
      { selector: 'debugName', imp: 0x1200n, types: '@16@0:8' },
      // Category/base conflict: load order can override the class method, so
      // this must remain ambiguous rather than choosing the higher class score.
      { selector: 'save:', imp: 0x1210n, types: 'v24@0:8@16' },
    ],
    classMethods: [],
  }],
  protocols: [
    {
      name: 'Trackable', instanceMethods: [], classMethods: [],
      optionalInstanceMethods: [{ selector: 'track:', types: 'v24@0:8@16' }], optionalClassMethods: [],
    },
    {
      name: 'Unrelated', instanceMethods: [], classMethods: [],
      optionalInstanceMethods: [{ selector: 'track:', types: 'v16@0:8' }], optionalClassMethods: [],
    },
  ],
};

const index = buildObjcRuntimeIndex(model);

// Category-only implementation resolves when metadata is complete and the
// explicit receiver proves the target class.
const category = resolveObjcDispatch(index, { receiverType: 'PlayerData', selector: 'debugName' });
assert.equal(category.resolved?.imp, 0x1200n);
assert.equal(category.resolved?.source, 'category');
assert.equal(category.resolved?.types, '@16@0:8');
assert.equal(category.resolved?.typeEncoding, '@16@0:8');
assert.equal(index.methodsByIMP.get('4608')?.[0]?.source, 'category');

// Explicit receiver type must not fall back to the same selector on another
// unrelated class.
const wrongReceiver = resolveObjcDispatch(index, { receiverType: 'ChildData', selector: 'debugName' });
assert.equal(wrongReceiver.resolved?.imp, 0x1200n, 'subclass should inherit category method on superclass');
const unrelatedReceiver = resolveObjcDispatch(index, { receiverType: 'NoSuchClass', selector: 'debugName' });
assert.equal(unrelatedReceiver.resolved, null);
assert.equal(unrelatedReceiver.candidates.length, 0);

// Inheritance narrowing remains valid for ordinary class methods.
const inherited = resolveObjcDispatch(index, { receiverType: 'ChildData', selector: 'baseOnly' });
assert.equal(inherited.resolved?.imp, 0x1110n);
assert.equal(inherited.resolved?.className, 'PlayerData');

// A protocol declaration is type evidence, never a concrete implementation.
// Category-adopted protocols participate in receiver-specific filtering.
const protocol = resolveObjcDispatch(index, { receiverType: 'PlayerData', selector: 'track:' });
assert.equal(protocol.resolved, null);
assert.equal(protocol.candidates.length, 0);
assert.equal(protocol.requirements.length, 1);
assert.equal(protocol.requirements[0].className, 'Trackable');
assert.equal(protocol.requirements[0].types, 'v24@0:8@16');
assert.equal(protocol.requirements[0].optional, true);

// Category + base implementation with different IMPs is runtime-order
// dependent and must not be falsely promoted to a verified target.
const override = resolveObjcDispatch(index, { receiverType: 'PlayerData', selector: 'save:' });
assert.equal(override.resolved, null);
assert.equal(override.candidates.length, 2);
assert.deepEqual(new Set(override.candidates.map((x) => x.imp)), new Set([0x1100n, 0x1210n]));

// Partial category metadata can hide an override, so even a currently unique
// target stays unresolved while preserving the observed candidate.
const partialIndex = buildObjcRuntimeIndex({
  ...model,
  runtimeCompleteness: { ...complete, categories: { present: true, complete: false }, complete: false },
  categories: [],
});
const partial = resolveObjcDispatch(partialIndex, { receiverType: 'PlayerData', selector: 'baseOnly' });
assert.equal(partial.resolved, null);
assert.equal(partial.candidates[0]?.imp, 0x1110n);
assert.equal(partial.partial, true);
assert.match(partial.reason, /partial/i);

// AI registry preserves the resolver ambiguity contract; it does not convert
// a resolved object/null result into a boolean or merge requirements into IMPs.
const registry = createHexToolRegistry({
  resolveObjcDispatch: async () => ({ resolved: null, candidates: [], requirements: protocol.requirements, confidence: 0.35, reason: 'protocol-only' }),
});
const toolResult = await registry.execute('resolve_objc_dispatch', { receiverClass: 'PlayerData', selector: 'track:' });
assert.equal(toolResult.result.resolved, null);
assert.equal(toolResult.result.requirements.length, 1);
assert.equal(toolResult.result.candidates.length, 0);

// Wiring assertions: App builds/caches the full model, normal UI/AI decompiler
// consume the cached runtime index, and the facade passes parser options using
// the parser's canonical 3-argument contract.
const objcSource = await readFile(new URL('../js/objc.js', import.meta.url), 'utf8');
assert.match(objcSource, /parseObjcExtendedMetadata\(read, runtimeSections, \{/);
assert.match(objcSource, /model\.runtimeIndex = buildObjcRuntimeIndex\(model\)/);
const appSource = await readFile(new URL('../js/app.js', import.meta.url), 'utf8');
assert.match(appSource, /buildObjcRuntimeModel/);
assert.match(appSource, /section === '__objc_protolist'/);
assert.match(appSource, /section === '__objc_catlist'/);
assert.match(appSource, /this\.objcRuntime = model\.runtimeIndex/);
assert.match(appSource, /if \(!list && !protocolList && !categoryList\)/);
const semanticSource = await readFile(new URL('../js/decompiler/semantic.js', import.meta.url), 'utf8');
assert.match(semanticSource, /opts\.objcRuntimeIndex \|\| opts\.objcModel/);
const toolsSource = await readFile(new URL('../js/tools.js', import.meta.url), 'utf8');
const toolsBaseSource = await readFile(new URL('../js/tools-base.js', import.meta.url), 'utf8');
assert.match(toolsSource, /installFunctionAnalysisPresentation/,
  'public tools wrapper must install the canonical presentation route before delegating');
assert.match(toolsBaseSource, /await app\.ensureObjc/,
  'compatibility renderer must still enrich decompiler output with ObjC metadata');
assert.match(toolsBaseSource, /objcRuntimeIndex: app\.objcRuntime \|\| null/);
const ctxSource = await readFile(new URL('../js/ai/ui/hex-context.js', import.meta.url), 'utf8');
assert.match(ctxSource, /async resolveObjcDispatch\(/);
assert.match(ctxSource, /receiverType: String\(receiverClass/);
assert.match(ctxSource, /objcRuntimeIndex: app\.objcRuntime \|\| null/);
const registrySource = await readFile(new URL('../js/ai/tools/registry.js', import.meta.url), 'utf8');
assert.match(registrySource, /register\('resolve_objc_dispatch'/);

console.log('issue #529 ObjC runtime integration: PASS');
