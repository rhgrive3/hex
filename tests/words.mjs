import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
vm.runInThisContext(fs.readFileSync(path.join(root, 'js', 'words.js'), 'utf8'), { filename: 'js/words.js' });

const { KIND, classifyWord } = globalThis.Words;
let passed = 0;

function eq(word, want, label) {
  const got = classifyWord(word >>> 0);
  if (got !== want) {
    throw new Error(`${label}: got kind ${got}, want ${want} for 0x${(word >>> 0).toString(16)}`);
  }
  passed++;
}

// ADD #0 is only the architectural MOV alias when SP/WSP participates.
eq(0x91000020, KIND.ARITH,  'add x0, x1, #0 stays arithmetic');
eq(0x11000020, KIND.ARITH,  'add w0, w1, #0 stays arithmetic');
eq(0x910003e0, KIND.MOVREG, 'add x0, sp, #0 is mov x0, sp');
eq(0x9100003f, KIND.MOVREG, 'add sp, x1, #0 is mov sp, x1');
eq(0x110003e0, KIND.MOVREG, 'add w0, wsp, #0 is mov w0, wsp');
eq(0x1100003f, KIND.MOVREG, 'add wsp, w1, #0 is mov wsp, w1');

// MOV is an ORR alias only for ORR Rd, ZR, Rm with no inversion or shift.
eq(0xaa0103e0, KIND.MOVREG, 'mov x0, x1');
eq(0x2a0103e0, KIND.MOVREG, 'mov w0, w1');
eq(0xaa2103e0, KIND.LOGIC,  'mvn x0, x1 is logic, not mov');
eq(0x2a2103e0, KIND.LOGIC,  'mvn w0, w1 is logic, not mov');
eq(0xaa0107e0, KIND.LOGIC,  'orr x0, xzr, x1, lsl #1 is logic');
eq(0x2a0107e0, KIND.LOGIC,  'orr w0, wzr, w1, lsl #1 is logic');

eq(0xb27be7ea, KIND.MOVIMM, 'mov x10, #logical-immediate alias');
eq(0x32183fe9, KIND.MOVIMM, 'mov w9, #logical-immediate alias');

// Integer one-source bit transforms are semantic shifts/bit operations.
eq(0xdac01108, KIND.SHIFT, 'clz x8, x8');
eq(0xdac002c8, KIND.SHIFT, 'rbit x8, x22');
eq(0xdac00d08, KIND.SHIFT, 'rev x8, x8');

// Fixed-point and Advanced-SIMD scalar integer/FP conversions are conversions.
eq(0x1e02fc00, KIND.FCONV, 'scvtf s0, w0, #1');
eq(0x1e42fd00, KIND.FCONV, 'scvtf d0, w8, #1');
eq(0x5e21d800, KIND.FCONV, 'scvtf s0, s0');

// FP one-source arithmetic and conversion instructions share an encoding family.
eq(0x1e20c020, KIND.FARITH, 'fabs s0, s1');
eq(0x1e214020, KIND.FARITH, 'fneg s0, s1');
eq(0x1e21c020, KIND.FARITH, 'fsqrt s0, s1');
eq(0x1e60c020, KIND.FARITH, 'fabs d0, d1');
eq(0x1e614020, KIND.FARITH, 'fneg d0, d1');
eq(0x1e61c020, KIND.FARITH, 'fsqrt d0, d1');
eq(0x1e22c020, KIND.FCONV,  'fcvt d0, s1');
eq(0x1e624020, KIND.FCONV,  'fcvt s0, d1');

// The patch assembler must accept disassembler condition aliases and preserve their canonical encoding.
const { assemble, suggestPatches } = await import('../js/patch.js');
const patchAt = 0x1000n;
const patchTarget = 0x1010n;
const branchBytes = (cond) => {
  const result = assemble(`b.${cond} 0x${patchTarget.toString(16)}`, patchAt);
  if (result.error || result.bytes?.length !== 4) {
    throw new Error(`b.${cond} did not assemble: ${result.error || 'invalid encoding'}`);
  }
  return result.bytes;
};
const branchWord = (cond) => {
  const bytes = branchBytes(cond);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
};
const sameBytes = (left, right) => {
  const a = Array.from(branchBytes(left)).join(',');
  const b = Array.from(branchBytes(right)).join(',');
  if (a !== b) throw new Error(`b.${left} and b.${right} encode differently: ${a} != ${b}`);
  passed++;
};
sameBytes('hs', 'cs');
sameBytes('lo', 'cc');
if ((branchWord('hs') & 0xf) !== 0x2) throw new Error('hs/cs condition code must be 0x2');
passed++;
if ((branchWord('lo') & 0xf) !== 0x3) throw new Error('lo/cc condition code must be 0x3');
passed++;
for (const alias of ['hs', 'lo']) {
  const invert = suggestPatches(`b.${alias}`, `#0x${patchTarget.toString(16)}`, patchAt)
    .find((candidate) => candidate.id === 'invert');
  if (!invert) throw new Error(`b.${alias} does not offer an invert patch`);
  const roundTrip = assemble(invert.text, patchAt);
  if (roundTrip.error || roundTrip.bytes?.length !== 4) {
    throw new Error(`${invert.text} emitted by suggestPatches does not round-trip`);
  }
  passed++;
}

process.stdout.write(`ARM64 word classification: ${passed} regressions ok\n`);

await import('./issue-556-address-provenance.mjs');
