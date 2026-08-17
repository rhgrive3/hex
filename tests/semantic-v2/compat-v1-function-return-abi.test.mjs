import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import { irFor, setSemanticMigrationMode, OP } from '../../js/ir.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';

const BASE = 0x100400000n;
function modelOf(lines) {
  const rows = lines.map((line, row) => {
    const split = line.indexOf(' ');
    return {
      row,
      address: BASE + BigInt(row * 4),
      mn: split < 0 ? line : line.slice(0, split),
      ops: split < 0 ? '' : line.slice(split + 1),
    };
  });
  const rowOfAddress = (address) => {
    const delta = BigInt(address) - BASE;
    return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
  };
  return { model: buildSemanticModel(rows, { startRow:0, endRow:rows.length - 1, rowOfAddress }), rowOfAddress };
}

try {
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
  const { model, rowOfAddress } = modelOf(['add w0, w0, #1', 'ret']);

  const untyped = irFor(model, { rowOfAddress, decoderSemanticVersion:'return-abi-untyped' });
  const untypedRet = untyped.instructions.find((inst) => inst.op === OP.RET);
  assert.ok(untypedRet, 'explicit v2 route must project RET');
  assert.deepEqual(untypedRet.args, [], 'architectural RET control target is not a source-language return value');
  assert.equal(untypedRet.returnReg, null, 'AAPCS64 alone must not invent a function return register');

  const typed = irFor(model, { rowOfAddress, returnType:'int32', decoderSemanticVersion:'return-abi-typed' });
  const typedRet = typed.instructions.find((inst) => inst.op === OP.RET);
  assert.ok(typedRet, 'typed explicit v2 route must project RET');
  assert.equal(typedRet.returnReg, 'x0');
  assert.equal(typedRet.returnEvidence, 'prototype-aapcs64');
  assert.equal(typedRet.args.length, 1, 'typed return binds one already-projected ABI state value');
  assert.equal(typedRet.args[0].value.reg, 'x0');
  assert.ok(typedRet.args[0].value.def, 'return value must have an existing reaching definition');
  assert.ok(typedRet.args[0].value.uses.includes(typedRet), 'return binding participates in legacy def-use');
} finally {
  setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);
}

console.log('semantic-v2 AAPCS64 function return compatibility projection: PASS');