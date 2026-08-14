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

// FP one-source arithmetic and conversion instructions share an encoding family.
eq(0x1e20c020, KIND.FARITH, 'fabs s0, s1');
eq(0x1e214020, KIND.FARITH, 'fneg s0, s1');
eq(0x1e21c020, KIND.FARITH, 'fsqrt s0, s1');
eq(0x1e60c020, KIND.FARITH, 'fabs d0, d1');
eq(0x1e614020, KIND.FARITH, 'fneg d0, d1');
eq(0x1e61c020, KIND.FARITH, 'fsqrt d0, d1');
eq(0x1e22c020, KIND.FCONV,  'fcvt d0, s1');
eq(0x1e624020, KIND.FCONV,  'fcvt s0, d1');

process.stdout.write(`ARM64 word classification: ${passed} regressions ok\n`);
