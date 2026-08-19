import fs from 'node:fs/promises';

async function read(path) { return fs.readFile(path, 'utf8'); }
async function write(path, content) { await fs.writeFile(path, content); }
async function replaceOnce(path, before, after) {
  const source = await read(path);
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`missing follow-up anchor in ${path}: ${before.slice(0,120)}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`ambiguous follow-up anchor in ${path}: ${before.slice(0,120)}`);
  await write(path, source.slice(0, first) + after + source.slice(first + before.length));
}

// Preserve the same resolved ELF ISA evidence on each structured decoder row.
await replaceOnce('js/platform/capstone-disasm-worker.js',
`              mode:msg.riscvIsa?.compressedInstructions === false ? 'rv64im' : 'rv64imc',
              isaIdentity:msg.riscvIsa?.canonical ?? null,
              isaEvidence:msg.riscvIsa?.evidence ?? null,
            }));`,
`              mode:msg.riscvIsa?.compressedInstructions === false ? 'rv64im' : 'rv64imc',
              isaIdentity:msg.riscvIsa?.canonical ?? null,
              isaEvidence:msg.riscvIsa?.evidence ?? null,
              instructionAlignment:msg.riscvIsa?.instructionAlignment ?? null,
              compressedInstructions:msg.riscvIsa?.compressedInstructions ?? null,
            }));`);

await replaceOnce('js/targets/architecture/riscv64/capstone-structured.js',
`      architecture: 'riscv64',
      mode: String(options.mode || 'rv64imc'),
      decoderSemanticVersion: 'capstone-5-riscv64-word-exact-v1',`,
`      architecture: 'riscv64',
      mode: String(options.mode || 'rv64imc'),
      ...(options.isaIdentity == null ? {} : { isaIdentity:String(options.isaIdentity) }),
      ...(options.isaEvidence == null ? {} : { isaEvidence:String(options.isaEvidence) }),
      ...(options.instructionAlignment == null ? {} : { instructionAlignment:Number(options.instructionAlignment) }),
      ...(options.compressedInstructions == null ? {} : { compressedInstructions:options.compressedInstructions === true }),
      decoderSemanticVersion: 'capstone-5-riscv64-word-exact-v1',`);

await replaceOnce('js/targets/architecture/riscv64/decoded-instruction.js',
`  if (mode === 'rv64im' && size === 2) throw new TypeError('riscv64-decoded-instruction-compressed-disabled');

  return Object.freeze({`,
`  if (mode === 'rv64im' && size === 2) throw new TypeError('riscv64-decoded-instruction-compressed-disabled');
  const instructionAlignment = Number(input.instructionAlignment ?? (mode === 'rv64im' ? 4 : 2));
  if (!Number.isSafeInteger(instructionAlignment) || ![2,4].includes(instructionAlignment)) {
    throw new TypeError('riscv64-decoded-instruction-invalid-instruction-alignment');
  }
  if (mode === 'rv64im' && instructionAlignment !== 4) throw new TypeError('riscv64-decoded-instruction-mode-alignment-mismatch');
  if (mode === 'rv64imc' && instructionAlignment !== 2) throw new TypeError('riscv64-decoded-instruction-mode-alignment-mismatch');

  return Object.freeze({`);
await replaceOnce('js/targets/architecture/riscv64/decoded-instruction.js',
`    architecture: 'riscv64',
    mode,
    address,`,
`    architecture: 'riscv64',
    mode,
    instructionAlignment,
    ...(input.isaIdentity == null ? {} : { isaIdentity:String(input.isaIdentity) }),
    ...(input.isaEvidence == null ? {} : { isaEvidence:String(input.isaEvidence) }),
    ...(input.compressedInstructions == null ? {} : { compressedInstructions:input.compressedInstructions === true }),
    address,`);

// MachineEffects metadata must retain the same ISA evidence used by the decoder.
await replaceOnce('js/targets/architecture/riscv64/effects/common.js',
`      compressed: fields.compressed === true,
      ...(fields.expandedFrom == null ? {} : { compressedEncoding: fields.expandedFrom }),`,
`      compressed: fields.compressed === true,
      instructionAlignment,
      ...(instruction.isaIdentity == null ? {} : { isaIdentity:String(instruction.isaIdentity) }),
      ...(instruction.isaEvidence == null ? {} : { isaEvidence:String(instruction.isaEvidence) }),
      ...(instruction.compressedInstructions == null ? {} : { compressedInstructions:instruction.compressedInstructions === true }),
      ...(fields.expandedFrom == null ? {} : { compressedEncoding: fields.expandedFrom }),`);

// Advertise both supported decode modes instead of claiming the C profile is the only one.
await replaceOnce('js/targets/architecture/index.js',
`  modes:()=>Object.freeze(['rv64imc']), registerFile:riscv64RegisterFile,`,
`  modes:()=>Object.freeze(['rv64im','rv64imc']), registerFile:riscv64RegisterFile,`);

// The resolved instruction alignment must enter the lifter context as well as artifact identity.
await replaceOnce('js/backend.js',
`            machineEffectsContext:{ dataEndianness, instructionEndianness },`,
`            machineEffectsContext:{
              dataEndianness,
              instructionEndianness,
              ...(riscvIsa?.instructionAlignment == null ? {} : { instructionAlignment:Number(riscvIsa.instructionAlignment) }),
            },`);

// Extend focused coverage to assert decoder/effect identity plumbing is present.
const testPath = 'tests/phase6/generic-core/issues-907-909-910-913.test.mjs';
const testSource = await read(testPath);
const extra = `\n\ntest('#909 structured decoder and MachineEffects preserve resolved ISA identity fields', async () => {\n  const decoderSource = await readFile(new URL('../../../js/targets/architecture/riscv64/capstone-structured.js', import.meta.url), 'utf8');\n  const decodedSource = await readFile(new URL('../../../js/targets/architecture/riscv64/decoded-instruction.js', import.meta.url), 'utf8');\n  const effectsSource = await readFile(new URL('../../../js/targets/architecture/riscv64/effects/common.js', import.meta.url), 'utf8');\n  assert.match(decoderSource, /isaIdentity/);\n  assert.match(decoderSource, /instructionAlignment/);\n  assert.match(decodedSource, /isaEvidence/);\n  assert.match(effectsSource, /isaIdentity/);\n  assert.match(effectsSource, /instructionAlignment/);\n});\n`;
if (!testSource.includes("structured decoder and MachineEffects preserve resolved ISA identity fields")) {
  await write(testPath, testSource + extra);
}

console.log('follow-up repair: RISC-V ISA identity propagation staged');
