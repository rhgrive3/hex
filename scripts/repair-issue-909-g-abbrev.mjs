import fs from 'node:fs/promises';

async function replaceOnce(path, before, after) {
  const source = await fs.readFile(path, 'utf8');
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`missing RISC-V G-abbrev anchor in ${path}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`ambiguous RISC-V G-abbrev anchor in ${path}`);
  await fs.writeFile(path, source.slice(0, first) + after + source.slice(first + before.length));
}

await replaceOnce('js/binary/riscv-isa.js',
`  const tokens = suffix.split('_').filter(Boolean);
  const compressedInstructions = tokens.some((token) => /^c(?:\\d|$)/.test(token) || /^zca(?:\\d|$)/.test(token))
    || (tokens.length === 1 && /^([ie])[a-z]*c[a-z0-9]*$/.test(tokens[0]));`,
`  const tokens = suffix.split('_').filter(Boolean);
  // The first token may use the compact single-letter extension sequence,
  // including the standard G abbreviation (for example rv64gc/rv64gcv).
  // Version digits stop that sequence; multi-letter Z* tokens are checked
  // independently so a 'c' inside zicbom etc. cannot masquerade as C.
  const compactRun = /^([a-z]+)/.exec(tokens[0] || '')?.[1] || '';
  const compressedInstructions = compactRun.includes('c')
    || tokens.some((token) => /^c(?:\\d|$)/.test(token) || /^zca(?:\\d|$)/.test(token));`);

const testPath = 'tests/phase6/generic-core/issues-907-909-910-913.test.mjs';
let testSource = await fs.readFile(testPath, 'utf8');
if (!testSource.includes("#909 rv64gc/G+C abbreviation preserves compressed capability")) {
  testSource += `\n\ntest('#909 rv64gc/G+C abbreviation preserves compressed capability', () => {\n  const gc = parseRiscvAttributes(attributesFor('rv64gc'));\n  assert.equal(gc.compressedInstructions, true);\n  assert.equal(gc.instructionAlignment, 2);\n\n  const gcv = parseRiscvMappingSymbol('$xrv64gcv');\n  assert.equal(gcv.isa.compressedInstructions, true);\n  assert.equal(gcv.isa.instructionAlignment, 2);\n});\n`;
  await fs.writeFile(testPath, testSource);
}
console.log('RISC-V G abbreviation compressed-profile detection staged');
