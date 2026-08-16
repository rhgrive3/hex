import assert from 'node:assert/strict';
import {
  assertDeterministicLift,
  canonicalDecodedInstruction,
  canonicalSemanticVersions,
} from '../../tools/validation/machine-effects/differential-harness.mjs';
import { TEST_SEMANTIC_VERSIONS, exactWriteBundle } from './verification-helpers.mjs';

const decoded = Object.freeze({
  mnemonic:'add',
  address:0x3000n,
  ops:[
    { k:'reg', cls:'gp', num:0, bits:64 },
    { k:'reg', cls:'gp', num:1, bits:64 },
    { k:'imm', value:1n },
  ],
});

const stable = await assertDeterministicLift({
  decodedInstruction:decoded,
  semanticVersions:TEST_SEMANTIC_VERSIONS,
  runs:4,
  machineLifter:() => exactWriteBundle({
    address:0x3000n,
    register:'x0',
    value:2n,
    metadata:{ z:2, a:1 },
  }),
});
assert.equal(stable.deterministic, true);
assert.equal(stable.runs, 4);
assert.equal(
  canonicalSemanticVersions({ b:'2', a:'1' }),
  canonicalSemanticVersions({ a:'1', b:'2' }),
  'semantic version object key order must not affect the determinism key',
);
assert.equal(
  canonicalDecodedInstruction({ b:2n, a:1n }),
  canonicalDecodedInstruction({ a:1n, b:2n }),
  'decoded instruction object key order must not affect the determinism key',
);

let sequence = 0n;
await assert.rejects(
  () => assertDeterministicLift({
    decodedInstruction:decoded,
    semanticVersions:TEST_SEMANTIC_VERSIONS,
    machineLifter:() => exactWriteBundle({ address:0x3000n, value:sequence++ }),
  }),
  /machine-effects-nondeterministic/,
);

console.log('machine-effects lift determinism: PASS');
