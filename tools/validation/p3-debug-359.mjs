import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR, OP, originOf, getLastSemanticV2Instrumentation } from '../../js/ir.js';

const BASE = 0x100000000n;
const lines = [
  'sub sp, sp, #32',
  'str x0, [sp, #16]',
  'str w2, [x0, #32]',
  'ldr x3, [sp, #16]',
  'add sp, sp, #32',
  'ret',
];
const rows = lines.map((line, i) => {
  const p = line.indexOf(' ');
  return { row: i, address: BASE + BigInt(i * 4), mn: p < 0 ? line : line.slice(0, p), ops: p < 0 ? '' : line.slice(p + 1) };
});
const rowOfAddress = (a) => {
  const d = a - BASE;
  return d < 0n || d >= BigInt(lines.length * 4) ? null : Number(d / 4n);
};
const model = buildSemanticModel(rows, { startRow: 0, endRow: lines.length - 1, rowOfAddress });
const ir = buildIR(model, { rowOfAddress });
const debug = getLastSemanticV2Instrumentation();
function value(v) {
  return v && {
    id: v.id,
    kind: v.kind,
    reg: v.reg ?? null,
    stateKey: v.stateKey ?? null,
    version: v.version ?? null,
    bits: v.bits ?? null,
    compatDerived: v.compatDerived ?? null,
    compatPublicIdentity: v.compatPublicIdentity ?? null,
    semanticValueId: v.semanticValueId ?? null,
    semanticSsaValueId: v.semanticSsaValueId ?? null,
    origin: originOf(v),
    def: v.def && { id: v.def.id, row: v.def.row, op: v.def.op, sub: v.def.sub, extra: v.def.extra },
  };
}
function instruction(i) {
  return i && {
    id: i.id,
    row: i.row,
    op: i.op,
    sub: i.sub,
    dst: value(i.dst),
    args: (i.args || []).map((a) => value(a?.value)),
    reachingStore: i.reachingStore?.id ?? null,
    extra: i.extra,
  };
}
const semanticIr = debug?.semanticIr ?? null;
const semanticRow3 = semanticIr?.nodes?.filter((node) => node.origin?.virtualRanges?.some((range) => range.start === BASE + 12n)) ?? [];
const semanticIds = new Set(semanticRow3.flatMap((node) => [...(node.inputs ?? []), ...(node.outputs ?? [])]));
console.log(JSON.stringify({
  row3: ir.instructions.filter((i) => i.row === 3).map(instruction),
  x3: ir.values.filter((v) => v.reg === 'x3' || v.compatPublicIdentity === 'x3').map(value),
  loads: ir.instructions.filter((i) => i.op === OP.LOAD).map(instruction),
  stateWrites: ir.instructions.filter((i) => i.extra?.stateWrite).map(instruction),
  semanticRow3,
  semanticValues: semanticIr?.values?.filter((v) => semanticIds.has(v.id)) ?? [],
  ssaDefinitions: debug?.ssa?.definitions?.filter((d) => semanticIds.has(d.proof?.sourceSemanticValueId) || semanticIds.has(d.valueId)) ?? [],
  ssaUses: debug?.ssa?.uses?.filter((u) => semanticIds.has(u.proof?.sourceSemanticValueId) || semanticIds.has(u.valueId)) ?? [],
}, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
