import { buildSemanticModel } from '../js/blocks.js';
import { buildCfg } from '../js/cfg.js';
import { decompile, decompiledText } from '../js/decompile.js';

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
assert(loop.model.backEdges.length === 1, 'real natural loop disappeared from semantic model');
assert(loop.cfg.backEdges.length === 1, 'real natural loop disappeared from CFG');
assert(loop.result.coverage.missing === 0, 'real loop decompile lost a block');
assert(/while \(|do\s+\{/.test(loop.text), 'real natural loop was not structured');
console.log('cfg-structuring regression: ok');
