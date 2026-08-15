import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { buildIR, OP } from '../js/ir.js';
import { expr } from '../js/decompiler/ast/nodes.js';
import { printExpression } from '../js/decompiler/pretty/c.js';
import {
  buildNZCVConditionExpression,
  evaluateNZCVCondition,
} from '../js/decompiler/flag-semantics.js';
import {
  effectiveIndexOffset,
  renderIndexedMemory,
} from '../js/decompiler/address-semantics.js';
import { renderMemoryLocation } from '../js/decompiler/semantic.js';
import { recoverAggregateLayouts } from '../js/decompiler/types/layout.js';
import { structureKnownSwitches } from '../js/decompiler/switch.js';

function oracleFlags(producer, left, right, bits) {
  const a = BigInt.asUintN(bits, BigInt(left));
  const b = BigInt.asUintN(bits, BigInt(right));
  const sign = 1n << BigInt(bits - 1);
  const mask = (1n << BigInt(bits)) - 1n;
  let result, c, v;
  if (producer === 'sub') {
    result = BigInt.asUintN(bits, a - b);
    c = a >= b;
    v = ((a ^ b) & (a ^ result) & sign) !== 0n;
  } else if (producer === 'add') {
    const wide = a + b;
    result = wide & mask;
    c = wide > mask;
    v = ((~(a ^ b)) & (a ^ result) & sign) !== 0n;
  } else if (producer === 'and') {
    result = a & b;
    c = false;
    v = false;
  } else throw new Error(`unknown producer ${producer}`);
  return { n:(result & sign) !== 0n, z:result === 0n, c, v };
}

function oracleCondition(producer, cond, left, right, bits) {
  const f = oracleFlags(producer, left, right, bits);
  switch (cond) {
    case 'eq': return f.z;
    case 'ne': return !f.z;
    case 'hs': case 'cs': return f.c;
    case 'lo': case 'cc': return !f.c;
    case 'mi': return f.n;
    case 'pl': return !f.n;
    case 'vs': return f.v;
    case 'vc': return !f.v;
    case 'hi': return f.c && !f.z;
    case 'ls': return !f.c || f.z;
    case 'ge': return f.n === f.v;
    case 'lt': return f.n !== f.v;
    case 'gt': return !f.z && f.n === f.v;
    case 'le': return f.z || f.n !== f.v;
    default: throw new Error(`unknown condition ${cond}`);
  }
}

const conditions = ['eq','ne','hs','cs','lo','cc','mi','pl','vs','vc','hi','ls','ge','lt','gt','le'];
const vectors = [
  [32, 0n, 0n],
  [32, 1n, 2n],
  [32, 0xffffffffn, 1n],
  [32, 0x7fffffffn, 1n],
  [32, 0x80000000n, 0xffffffffn],
  [64, 0xffffffffffffffffn, 1n],
  [64, 0x7fffffffffffffffn, 1n],
];

for (const producer of ['sub','add','and']) {
  for (const [bits,left,right] of vectors) {
    for (const cond of conditions) {
      assert.equal(
        evaluateNZCVCondition(producer, cond, left, right, bits),
        oracleCondition(producer, cond, left, right, bits),
        `${producer}.${cond}/${bits}: ${left.toString(16)}, ${right.toString(16)}`,
      );
    }
  }
}

// ADDS/CMN signed conditions must retain V. INT_MAX+1 has N=1,V=1, so GE is true.
assert.equal(evaluateNZCVCondition('add', 'ge', 0x7fffffffn, 1n, 32), true);
const a32 = expr.variable('a', 32, null);
const b32 = expr.variable('b', 32, null);
const addGe = buildNZCVConditionExpression('add', 'ge', a32, b32, 32);
assert.equal(addGe.kind, 'intrinsic');
assert.match(printExpression(addGe), /__arm64_nzcv_add_ge_32/);
const addEq = buildNZCVConditionExpression('add', 'eq', a32, b32, 32);
assert.equal(addEq.kind, 'compare');
const tstHs = buildNZCVConditionExpression('and', 'hs', a32, b32, 32);
assert.equal(tstHs.kind, 'const');
assert.equal(tstHs.value, 0n);

// Indexed addressing: the extension happens before the scale.
assert.equal(effectiveIndexOffset(0xffffffffn, 'sxtw', 2), -4n);
assert.equal(effectiveIndexOffset(0xffffffffn, 'uxtw', 2), 0x3fffffffcn);
assert.equal(
  renderIndexedMemory('base', 'idx', { extend:'sxtw', scale:2, size:4 }),
  'base[(int64_t)(int32_t)idx]',
);

const BASE = 0x100000000n;
function asm(lines) {
  return lines.map((line, i) => {
    const s = String(line).trim();
    const sp = s.indexOf(' ');
    return { row:i, address:BASE + BigInt(i) * 4n, mn:sp < 0 ? s : s.slice(0, sp), ops:sp < 0 ? '' : s.slice(sp + 1).trim() };
  });
}
function build(lines) {
  const rowOfAddress = (addr) => {
    const rel = addr - BASE;
    return rel < 0n || rel >= BigInt(lines.length) * 4n ? null : Number(rel / 4n);
  };
  const model = buildSemanticModel(asm(lines), { startRow:0, endRow:lines.length - 1, rowOfAddress });
  return { model, ir:buildIR(model, { rowOfAddress }) };
}

const indexed = build(['ldr w8, [x0, w1, sxtw #2]', 'ret']);
const indexedLoad = indexed.ir.instructions.find((i) => i.op === OP.LOAD);
assert.ok(indexedLoad, 'indexed load must lift');
assert.equal(indexedLoad.addr.extend, 'sxtw');
assert.equal(Number(indexedLoad.addr.scale), 2, 'extend shift amount must survive IR lifting');
const indexedText = renderMemoryLocation(indexedLoad.loc, indexedLoad, {
  ir:indexed.ir,
  model:indexed.model,
  opts:{},
  types:{ values:new Map() },
  runtime:null,
  storedValueAliases:new Map(),
});
assert.match(indexedText, /int32_t/, 'semantic memory rendering must preserve sxtw');

// Aggregate fields with the same offset must keep receiver identity.
const enemy = { id:101, reg:'x0' };
const player = { id:202, reg:'x1' };
const aggregateIR = { instructions:[
  { id:1, row:1, op:'load', loc:{ kind:'field', base:enemy, disp:0x20n, size:4, key:'enemy:20' }, addr:{ base:enemy, disp:0x20n, size:4 } },
  { id:2, row:2, op:'store', loc:{ kind:'field', base:enemy, disp:0x24n, size:4, key:'enemy:24' }, addr:{ base:enemy, disp:0x24n, size:4 } },
  { id:3, row:3, op:'load', loc:{ kind:'field', base:player, disp:0x20n, size:4, key:'player:20' }, addr:{ base:player, disp:0x20n, size:4 } },
  { id:4, row:4, op:'store', loc:{ kind:'field', base:player, disp:0x24n, size:4, key:'player:24' }, addr:{ base:player, disp:0x24n, size:4 } },
] };
const aggregateTypes = { values:new Map([
  [enemy.id, { className:'Enemy' }],
  [player.id, { className:'Player' }],
]) };
const ownerCalls = [];
const layouts = recoverAggregateLayouts(aggregateIR, aggregateTypes, {
  fieldFor(owner, offset) {
    ownerCalls.push(owner);
    if (offset !== 0x20n) return null;
    if (owner === 'Enemy') return { name:'hp', type:'int32_t' };
    if (owner === 'Player') return { name:'coins', type:'int32_t' };
    return { name:'leaked', type:'int32_t' };
  },
});
assert.ok(!ownerCalls.includes(null), 'field resolver must never receive a null owner for grouped object fields');
const enemyLayout = layouts.find((x) => x.owner === 'Enemy');
const playerLayout = layouts.find((x) => x.owner === 'Player');
assert.equal(enemyLayout.fields.find((f) => f.offset === 0x20n).name, 'hp');
assert.equal(playerLayout.fields.find((f) => f.offset === 0x20n).name, 'coins');
assert.equal(enemyLayout.fields.find((f) => f.offset === 0x20n).confidence, 0.95);

// Switch case identity is numeric, not textual, and width makes -1 == 0xffffffff for int32.
function assertSwitchConflict(cases, extra = {}) {
  const result = { lines:[], evidence:[], warnings:[], ir:{ blocks:[] } };
  const model = { instructions:[], switches:[{ row:7, bits:32, signed:true, cases, ...extra }] };
  structureKnownSwitches(result, model, {});
  assert.ok(result.warnings.some((x) => /descriptor conflict/i.test(x)), `missing conflict warning: ${result.warnings.join(' | ')}`);
  assert.ok(result.evidence.some((x) => x.op === 'switch-conflict'), 'missing switch-conflict evidence');
}
assertSwitchConflict([
  { value:'10', address:0x1000n },
  { value:'0xA', address:0x1004n },
]);
assertSwitchConflict([
  { value:'-1', address:0x1000n },
  { value:'0xffffffff', address:0x1004n },
]);
assertSwitchConflict([
  { value:'-1', address:0x1000n },
  { value:'0xffffffffffffffff', address:0x1004n },
], { bits:64, signed:true });

console.log('issues #400-#405 regression tests passed');
