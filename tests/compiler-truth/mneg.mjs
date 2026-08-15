import assert from 'node:assert/strict';
import { buildSemanticModel } from '../../js/blocks.js';
import { decompile } from '../../js/decompile.js';
import { buildIR } from '../../js/ir.js';

const BASE = 0x100000000n;

function make(lines, bits = 64) {
  const raw = lines.map((text, row) => {
    const p = text.indexOf(' ');
    return { row, address: BASE + BigInt(row * 4), mn: p < 0 ? text : text.slice(0, p), ops: p < 0 ? '' : text.slice(p + 1) };
  });
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - BASE;
    return d >= 0n && d < BigInt(raw.length * 4) ? Number(d / 4n) : null;
  };
  const model = buildSemanticModel(raw, {
    startRow: 0,
    endRow: raw.length - 1,
    rowOfAddress,
    symbolFor: () => null,
    name: `mneg_${bits}`,
  });
  return { model, rowOfAddress };
}

function decompileStore(lines, bits) {
  const { model, rowOfAddress } = make(lines, bits);
  const result = decompile(model, {
    addr: BASE,
    name: `mneg_${bits}`,
    rowOfAddress,
    receiverType: 'Box',
    beginner: false,
    fieldFor: (_base, off) => off === 0x20n ? { name: 'value', type: bits === 32 ? 'int32' : 'int64' } : null,
  });
  assert.equal(result.semantic, true, result.warnings?.join('\n'));
  return result;
}

// Variable operands: the lifted BIN node stores MNEG semantic metadata in
// `extra.negate`. Rewrite/pretty-print must preserve it for both widths.
for (const [bits, prefix] of [[32, 'w'], [64, 'x']]) {
  const r = decompileStore([
    `mneg ${prefix}8, ${prefix}1, ${prefix}2`,
    `${prefix === 'w' ? 'str w8' : 'str x8'}, [x0, #0x20]`,
    'ret',
  ], bits);
  assert.match(r.pseudocode, /self->value\s*=\s*-\s*\([^\n;]*a2[^\n;]*\*[^\n;]*a3[^\n;]*\)/,
    `${bits}-bit MNEG lost negation:\n${r.pseudocode}`);
  assert.doesNotMatch(r.pseudocode, /self->value\s*=\s*(?:\([^)]*\)\s*)?a2\s*\*\s*a3\s*;/,
    `${bits}-bit MNEG became positive multiply:\n${r.pseudocode}`);
}

// Nested expression: negation must remain attached to the multiplication after
// expression reconstruction and rewrite, not accidentally to the outer add.
{
  const r = decompileStore([
    'mneg w8, w1, w2',
    'add w8, w8, w3',
    'str w8, [x0, #0x20]',
    'ret',
  ], 32);
  assert.match(r.pseudocode, /-\s*\([^\n;]*a2[^\n;]*\*[^\n;]*a3[^\n;]*\)[^\n;]*\+[^\n;]*a4/,
    `nested MNEG lost/moved negation:\n${r.pseudocode}`);
}

// Constant propagation already consumes `extra.negate`; lock that contract for
// 32- and 64-bit values so the fast path cannot diverge from variable operands.
for (const [bits, prefix] of [[32, 'w'], [64, 'x']]) {
  const { model } = make([
    `mov ${prefix}1, #2`,
    `mov ${prefix}2, #3`,
    `mneg ${prefix}8, ${prefix}1, ${prefix}2`,
    'ret',
  ], bits);
  const ir = buildIR(model);
  const mneg = ir.instructions.find((inst) => inst.op === 'bin' && inst.sub === 'mul' && inst.extra?.negate);
  assert.ok(mneg, `${bits}-bit MNEG did not retain extra.negate`);
  assert.equal(mneg.dst?.const, BigInt.asUintN(bits, -6n), `${bits}-bit constant MNEG folded with wrong sign`);
}

console.log('compiler-truth MNEG: PASS');
