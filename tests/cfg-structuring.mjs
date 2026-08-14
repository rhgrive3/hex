import { buildSemanticModel } from '../js/blocks.js';
import { buildCfg } from '../js/cfg.js';
import { decompile, decompiledText } from '../js/decompile.js';
import { analyzeGraph } from '../js/controlflow.js';

const BASE = 0x100000000n;
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function asm(lines) {
  return lines.map((line, i) => {
    const x = String(line).trim(); const p = x.indexOf(' ');
    return { row: i, address: BASE + BigInt(i) * 4n,
      mn: p < 0 ? x : x.slice(0, p), ops: p < 0 ? '' : x.slice(p + 1) };
  });
}
function make(lines) {
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - BASE;
    return d >= 0n && d < BigInt(lines.length) * 4n ? Number(d / 4n) : null;
  };
  const model = buildSemanticModel(asm(lines), { startRow: 0, endRow: lines.length - 1, rowOfAddress });
  const result = decompile(model, { addr: BASE, rowOfAddress,
    addrOfRow: (r) => BASE + BigInt(r) * 4n, symbolFor: () => null });
  return { model, cfg: buildCfg(model, { rowOfAddress }), result, text: decompiledText(result) };
}

// Optimized cleanup layout: row 5 jumps backwards to row 1, but row 1 does not
// dominate row 5. There is no cycle and therefore no loop.
const cleanup = make([
  'cbz x0, #0x100000010',
  'mov x1, #0x1',
  'b #0x100000018',
  'nop',
  'mov x2, #0x2',
  'b #0x100000004',
  'ret',
]);
assert(cleanup.model.backEdges.length === 0, 'blocks.js misclassified cleanup jump as loop');
assert(cleanup.cfg.backEdges.length === 0, 'cfg.js misclassified cleanup jump as loop');
assert(cleanup.result.coverage && cleanup.result.coverage.missing === 0, 'decompiler dropped reachable blocks');
assert(!cleanup.text.includes('条件は読み取れません */ 1'), 'decompiler invented an infinite loop condition');
assert(!cleanup.text.includes('while (1)'), 'cleanup jump became a fake infinite loop');

const loop = make([
  'mov x0, #0x0',
  'add x0, x0, #0x1',
  'cmp x0, #0xa',
  'b.ne #0x100000004',
  'ret',
]);
console.log('SEM_LOOP_DIAG', JSON.stringify({
  text: loop.text,
  semantic: loop.result.semantic,
  legacyFallback: loop.result.legacyFallback,
  coverage: loop.result.coverage,
  loops: (loop.result.ir?.loops || []).map((x) => ({ header: x.header, nodes: [...x.nodes], exits: [...x.exits] })),
  inductions: (loop.result.ctx?.inductions || []).map((x) => ({ name: x.name, header: x.loop?.header, step: String(x.step), init: x.init?.const == null ? null : String(x.init.const) })),
  blocks: (loop.result.ir?.blocks || []).map((b) => ({ index: b.index, startRow: b.startRow, endRow: b.endRow, succ: b.succ, ops: (b.insts || []).map((i) => ({ op: i.op, sub: i.sub, row: i.row, cond: i.cond, target: i.extra?.target == null ? null : String(i.extra.target) })) })),
  lines: (loop.result.lines || []).map((l) => ({ kind: l.kind, indent: l.indent, row: l.row, text: l.text })),
}, (_k, v) => typeof v === 'bigint' ? String(v) : v));
assert(loop.model.backEdges.length === 1, 'real natural loop disappeared from semantic model');
assert(loop.cfg.backEdges.length === 1, 'real natural loop disappeared from CFG');
assert(loop.result.coverage.missing === 0, 'real loop decompile lost a block');
assert(/while \(|do\s+\{/.test(loop.text), 'real natural loop was not structured');

// A branch that can either exit or disappear into a closed infinite SCC has no
// safe immediate post-dominator. Treating one as a merge would invent an if.
const nonTerm = analyzeGraph([[1, 2], [1], []], 0);
assert(nonTerm.immediatePostDominators[0] == null,
  'post-dominator invented across a non-terminating path');

// Indirect branches are not statically connected to their jump-table targets.
// The decompiler must still preserve both the `br` itself and every block in
// the function range instead of silently dropping the disconnected chunk.
const indirect = make([
  'br x8',
  'mov x0, #0x1',
  'ret',
]);
assert(indirect.text.includes('__asm("br x8")'), 'indirect branch disappeared');
assert(indirect.result.coverage.missing === 0, 'disconnected function block disappeared');
assert(indirect.result.coverage.emitted === indirect.result.coverage.total,
  'coverage does not include every Basic Block');
assert(indirect.result.coverage.mode === 'linear', 'disconnected CFG did not use faithful mode');

console.log('cfg-structuring regression: ok');