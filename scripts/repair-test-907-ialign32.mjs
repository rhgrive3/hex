import fs from 'node:fs/promises';
const path = 'tests/phase6/generic-core/issues-907-909-910-913.test.mjs';
const source = await fs.readFile(path, 'utf8');
const before = `  const branch = liftRiscv64ControlEffects(rvControl('beq'), { instructionAlignment:4 });\n  assert.equal(branch.possibleFaults.length, 1);`;
const after = `  const branch = liftRiscv64ControlEffects(rvControl('beq', { imm:2 }), { instructionAlignment:4 });\n  assert.equal(branch.possibleFaults.length, 1);`;
if (!source.includes(before)) throw new Error('missing IALIGN=32 focused-test anchor');
await fs.writeFile(path, source.replace(before, after));
console.log('IALIGN=32 regression now exercises a non-degenerate misaligned target');
