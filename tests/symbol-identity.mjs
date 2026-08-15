import assert from 'node:assert/strict';
import { SymbolIndex } from '../js/symbols.js';

function makeIndex() {
  return new SymbolIndex({
    addrs: new BigUint64Array([0x1000n, 0x1010n, 0x1200n]),
    kinds: new Uint8Array([0, 0, 0]),
    names: '_known\nL_local\n_global_after',
    funcs: new BigUint64Array([0x1000n, 0x1100n]),
  });
}

{
  const index = makeIndex();
  assert.equal(index.label(0x1004n), '_known+0x4', 'normal in-function symbol offsets should remain');
  assert.equal(index.label(0x1014n), 'L_local+0x4', 'local labels inside the same function should remain valid');

  assert.equal(index.label(0x1100n), null, 'an unnamed function start must not borrow the previous function name');
  assert.equal(index.label(0x1108n), null, 'an unnamed function body must not inherit a symbol from the previous function');
}

{
  const index = makeIndex();
  index.rename(0x1000n, 'Player::tick');
  assert.equal(index.label(0x1000n), 'Player::tick');
  assert.equal(index.label(0x1008n), 'Player::tick+0x8', 'rename should propagate through the renamed function body');

  index.rename(0x1100n, 'Player::update');
  assert.equal(index.nameAt(0x1100n), 'Player::update', 'rename should identify a stripped function exactly');
  assert.equal(index.label(0x110cn), 'Player::update+0xC', 'rename of a stripped function must propagate without an original symbol');

  index.rename(0x1100n, '');
  assert.equal(index.nameAt(0x1100n), null, 'clearing rename should restore stripped state');
  assert.equal(index.label(0x110cn), null, 'clearing rename must not fall back across the previous function boundary');
}

{
  const index = makeIndex();
  index.rename(0x1008n, 'interesting_branch');
  assert.equal(index.label(0x100cn), 'interesting_branch+0x4', 'explicit local renames may label later addresses in the same function');
  assert.equal(index.label(0x1104n), null, 'local rename must not leak into the next function');
}


{
  const index = new SymbolIndex({
    funcs: new BigUint64Array([0x1000n, 0x1100n, 0x3000n, 0x90000n]),
    regions: [
      { id:'text-a', vmAddr:0x1000n, size:0x1000n, exec:true },
      { id:'text-b', vmAddr:0x3000n, size:0x100000n, exec:true },
      { id:'data', vmAddr:0x2000n, size:0x1000n, exec:false },
    ],
  });
  assert.deepEqual(index.functionAt(0x1080n), { start:0x1000n, end:0x1100n, index:0 },
    'normal same-region next-start interval should be contained');
  assert.deepEqual(index.functionAt(0x1100n), { start:0x1100n, end:null, index:1 },
    'an exact last start in an executable region remains identifiable');
  assert.equal(index.functionAt(0x1180n), null,
    'last function must not absorb trailing padding when no end is known');
  assert.equal(index.functionAt(0x2800n), null,
    'addresses in another/non-executable region must not be attributed to a previous function');
  assert.equal(index.functionAt(0x5000n), null,
    'a huge next-start gap must not be treated as one giant function');
}

{
  const index = new SymbolIndex({
    funcs: new BigUint64Array([0x1000n]),
    funcEnds: new BigUint64Array([0x1080n]),
    regions: [{ id:'text', vmAddr:0x1000n, size:0x1000n, exec:true }],
  });
  assert.deepEqual(index.functionAt(0x107cn), { start:0x1000n, end:0x1080n, index:0 },
    'explicit function end should permit bounded interior containment');
  assert.equal(index.functionAt(0x1080n), null, 'explicit function end is exclusive');
}

console.log('symbol identity regression: PASS');
