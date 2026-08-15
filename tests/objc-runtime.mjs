import assert from 'node:assert/strict';
import {
  buildObjcRuntimeIndex, resolveObjcDispatch, objcMessage,
  recognizeObjcBlockLiteral, buildSelectorIndex, resolveSelectorStub,
} from '../js/objc.js';
import { resolveObjcIMP, runtimeOriginForSymbol, buildAppleRuntimeIndex } from '../js/apple/runtime.js';

const model = {
  classes: [
    {
      name: 'NSObject', superName: null,
      methods: [{ sel: 'description', addr: 0x1000n }], classMethods: [], protocols: [],
    },
    {
      name: 'PlayerData', superName: 'NSObject', protocols: ['CoinProviding'],
      methods: [{ sel: 'addCoins:', addr: 0x2000n }],
      classMethods: [{ sel: 'shared', addr: 0x2100n }],
      ivars: [{ name: '_coins', offset: 0x20, type: { kind: 'int', bytes: 4 } }],
    },
  ],
  protocols: [
    { name: 'CoinProviding', methods: [{ sel: 'coinCount', addr: null }] },
  ],
  categories: [
    { name: 'Debug', className: 'PlayerData', methods: [{ sel: 'debugName', addr: 0x2200n }] },
  ],
};

const index = buildObjcRuntimeIndex(model);
{
  const r = resolveObjcDispatch(index, { receiverType: 'PlayerData *', selector: 'addCoins:' });
  assert.equal(r.resolved?.imp, 0x2000n);
  assert.equal(r.resolved?.className, 'PlayerData');
}
{
  const r = resolveObjcDispatch(index, { receiverType: 'PlayerData *', selector: 'description' });
  assert.equal(r.resolved?.className, 'NSObject');
}
{
  const r = resolveObjcDispatch(index, { receiverType: 'PlayerData *', selector: 'debugName' });
  assert.equal(r.resolved?.source, 'category');
}
{
  const r = resolveObjcDispatch(index, { receiverType: 'PlayerData *', selector: 'coinCount' });
  // Protocol entries describe required methods; they do not carry an
  // implementation IMP and must never be promoted to a resolved dispatch.
  assert.equal(r.resolved, null);
  assert.equal(r.candidates.length, 0);
  assert.equal(r.requirements.length, 1);
  assert.equal(r.requirements[0].source, 'protocol');
  assert.equal(r.requirements[0].selector, 'coinCount');
}
{
  const m = objcMessage(index, { receiver: 'player', receiverType: 'PlayerData *', selector: 'addCoins:', args: ['amount'] });
  assert.equal(m.text, '[player addCoins:amount]');
  assert.equal(m.dispatch.resolved?.imp, 0x2000n);
}
{
  const selectors = buildSelectorIndex({
    selectorRefs: [{ addr: 0x4000n, selector: 'addCoins:' }],
    stubs: [{ addr: 0x5000n, name: '_objc_msgSend$addCoins:' }],
    fixups: [{ addr: 0x6000n, selector: 'description' }],
  });
  const r = resolveSelectorStub({ address: 0x5000n, symbol: '_objc_msgSend$addCoins:', selectorIndex: selectors });
  assert.equal(r.selector, 'addCoins:');
  assert.equal(r.ambiguous, false);
}
{
  const block = recognizeObjcBlockLiteral(new Map([[0, 0x1111n], [8, 0x40000000], [16, 0x2222n], [24, 0x3333n], [32, 'capturedSelf']]));
  assert.equal(block.kind, 'block');
  assert.equal(block.invoke, 0x2222n);
  assert.equal(block.captures.length, 1);
}
{
  const imp = resolveObjcIMP(index, 0x2000n, { receiverType: 'PlayerData *', selector: 'addCoins:' });
  assert.equal(imp.resolved?.selector, 'addCoins:');
  assert.equal(imp.confidence, 0.98);
}
{
  assert.equal(runtimeOriginForSymbol('-[PlayerData addCoins:]'), 'objc');
  assert.equal(runtimeOriginForSymbol('_ZN10GameObject6updateEv'), 'cpp');
  assert.equal(runtimeOriginForSymbol('_$s4Game6updateyyF'), 'swift');
  const mixed = buildAppleRuntimeIndex({ objc: model, swift: { types: [] } });
  assert.equal(mixed.runtime, 'mixed');
  assert.ok(mixed.objc.classes.has('PlayerData'));
}

console.log('objc-runtime: ok');
