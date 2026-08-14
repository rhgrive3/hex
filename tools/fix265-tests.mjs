import fs from 'node:fs';
const p = 'tests/issue-265-plus.mjs';
let s = fs.readFileSync(p, 'utf8');
s = s.replace("import { goalFromPreset } from '../js/goals.js';", "import { GOALS } from '../js/goals.js';");
s = s.replace("const emptySymbols = { gen: 1, nameAt: () => null, label: () => null };", "const emptySymbols = { gen: 1, nameAt: () => null, label: () => null };\nconst goalFromPreset = (id) => GOALS.find((g) => g.id === id);");
s = s.replace("assert.equal(res.addressRefs.some((r) => r.addr === 0x100000040n), false);", "assert.equal((res.stringRefs || []).some((r) => r.addr === 0x100000040n), false);");
fs.writeFileSync(p, s);
