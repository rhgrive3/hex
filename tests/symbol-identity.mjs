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

console.log('symbol identity regression: PASS');
