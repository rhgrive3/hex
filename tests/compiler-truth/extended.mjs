import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseOperands } from '../../js/arm64.js';
import { decompile } from '../../js/decompile.js';
import { evaluateExpression } from '../../js/decompiler/verify/equivalence.js';
import { s, u } from '../../js/decompiler/truth/integer.js';
import { ghidraAvailability, runGhidra, readabilityMetrics } from '../../tools/decompiler/ghidra-diff.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, 'sources', 'extended.c');
const optimizations = ['-O2', '-O3', '-Os', '-Oz'];

function codeText(line) { return String(line || '').replace(/\/\/.*$/, '').trim(); }

function memoryInfo(mn, ops) {
  const m = String(mn).toLowerCase();
  if (!/^(?:ld|st)/.test(m)) return null;
  const mem = ops.find((o) => o?.k === 'mem');
  if (!mem) return null;
  const first = ops.find((o) => o?.k === 'reg');
  let size = Math.max(1, Number(first?.bits || 64) / 8);
  if (/b$/.test(m) || /rb$/.test(m)) size = 1;
  else if (/h$/.test(m) || /rh$/.test(m)) size = 2;
  else if (/sw$/.test(m)) size = 4;
  if (/^(?:ldp|stp|ldnp|stnp)/.test(m)) size *= 2;
  return { kind: /^ld/.test(m) ? 'load' : 'store', size, stack: mem.base?.cls === 'sp' || mem.base?.num === 29 };
}

function parseFunction(asm, fn, baseAddress) {
  const all = String(asm || '').split(/\r?\n/);
  const start = all.findIndex((line) => codeText(line) === `${fn}:`);
  if (start < 0) return null;
  let end = all.length;
  for (let i = start + 1; i < all.length; i++) {
    const code = codeText(all[i]);
    if (/^\.Lfunc_end\d+:/.test(code) || (/^[A-Za-z_$][\w$]*:\s*$/.test(code) && !/^\.L/.test(code))) { end = i; break; }
  }
  const raw = [];
  const labels = new Map();
  let row = 0;
  for (let i = start + 1; i < end; i++) {
    const text = codeText(all[i]);
    if (!text) continue;
    const label = /^(\.L[\w.$]+):/.exec(text);
    if (label) { labels.set(label[1], row); continue; }
    if (text.startsWith('.') || text.startsWith('#')) continue;
    const ins = /^([A-Za-z][\w.]*)\s*(.*)$/.exec(text);
    if (!ins) continue;
    raw.push({ row: row++, mnemonic: ins[1].toLowerCase(), operands: ins[2].trim() });
  }
  if (!raw.length) return null;
  const addressOfRow = (r) => baseAddress + BigInt(r) * 4n;
  const instructions = raw.map((item) => {
    const ops = parseOperands(item.operands);
    const mn = item.mnemonic;
    const targetText = item.operands.split(',').at(-1)?.trim();
    const targetRow = labels.get(targetText);
    const conditional = /^b\.[a-z]{2}$/.test(mn) || /^(?:cbz|cbnz|tbz|tbnz)$/.test(mn);
    const branch = mn === 'b' || mn === 'br' || conditional;
    const call = mn === 'bl' || mn === 'blr';
    return {
      ...item,
      ops,
      address: addressOfRow(item.row),
      isReturn: mn === 'ret',
      isBranch: branch,
      isConditional: conditional,
      isCall: call,
      branchTarget: targetRow == null ? null : addressOfRow(targetRow),
      callTarget: null,
      memory: memoryInfo(mn, ops),
      reads: [], writes: [], data: false,
    };
  });
  const starts = new Set([0]);
  for (const ins of instructions) {
    if (ins.branchTarget != null) starts.add(Number((ins.branchTarget - baseAddress) / 4n));
    if ((ins.isBranch || ins.isReturn) && ins.row + 1 < instructions.length) starts.add(ins.row + 1);
  }
  const sorted = [...starts].filter((x) => x >= 0 && x < instructions.length).sort((a, b) => a - b);
  const basicBlocks = sorted.map((startRow, index) => {
    const next = sorted[index + 1] ?? instructions.length;
    return { startRow, endRow: next - 1, rows: Array.from({ length: next - startRow }, (_, k) => startRow + k) };
  });
  return { name: fn, instructions, basicBlocks, semantic: [], calls: [] };
}

const specs = {
  abs_i32: {
    truth: (x) => u(s(x, 32) < 0n ? -s(x, 32) : s(x, 32), 32),
  },
  max_u32: {
    truth: (a, b) => u(a, 32) > u(b, 32) ? u(a, 32) : u(b, 32),
  },
  min_u32: {
    truth: (a, b) => u(a, 32) < u(b, 32) ? u(a, 32) : u(b, 32),
  },
  mask_low8: {
    truth: (x) => u(x, 32) & 0xffn,
  },
  clear_low8: {
    truth: (x) => u(x, 32) & 0xffffff00n,
  },
  bit_test5: {
    truth: (x) => (u(x, 32) & 0x20n) !== 0n ? 1n : 0n,
  },
  choose_u32: {
    truth: (cond, a, b) => u(cond, 32) !== 0n ? u(a, 32) : u(b, 32),
  },
  shl3_add: {
    truth: (x, y) => u((u(x, 32) << 3n) + u(y, 32), 32),
  },
  neg_if: {
    truth: (x, flag) => u(u(flag, 32) !== 0n ? -s(x, 32) : s(x, 32), 32),
  },
  inc_if: {
    truth: (x, flag) => u(u(flag, 32) !== 0n ? u(x, 32) + 1n : u(x, 32), 32),
  },
  inv_if: {
    truth: (x, flag) => u(u(flag, 32) !== 0n ? ~u(x, 32) : u(x, 32), 32),
  },
  extract16: {
    truth: (x) => (u(x, 32) >> 8n) & 0xffffn,
  },
  clamp_i32: {
    truth: (x, lo, hi) => {
      const sx = s(x, 32), slo = s(lo, 32), shi = s(hi, 32);
      return u(sx < slo ? slo : sx > shi ? shi : sx, 32);
    },
  },
  clamp_u32: {
    truth: (x, hi) => u(x, 32) > u(hi, 32) ? u(hi, 32) : u(x, 32),
  },
};

const cases = [0n, 1n, -1n, 2n, -2n, 0x1fn, 0x20n, 0xffn, 0x100n, 0x12345678n, 0x7fffffffn, 0xffffffffn];

function semanticTruth(fn, result) {
  const expression = result?.semanticAst?.outputs?.find((x) => x.name === 'return')?.expression;
  if (!expression) return { checked: 0, equivalent: null, reason: 'return expression unavailable' };
  const inputs = result.semanticAst.inputs || [];
  let checked = 0;
  for (let i = 0; i < cases.length; i++) {
    const args = inputs.map((_input, index) => cases[(i + index * 3) % cases.length]);
    const env = {};
    for (let index = 0; index < inputs.length; index++) env[inputs[index].name] = args[index];
    for (let index = 0; index < args.length; index++) {
      env[`arg${index + 1}`] = args[index];
      env[`a${index + 1}`] = args[index];
    }
    const actual = evaluateExpression(expression, env);
    if (actual == null) continue;
    const expected = specs[fn].truth(...args);
    checked++;
    if (u(actual, 32) !== u(expected, 32)) {
      return { checked, equivalent: false, counterexample: { env, actual: String(actual), expected: String(expected) } };
    }
  }
  return { checked, equivalent: checked ? true : null };
}

function compileAssembly(opt) {
  const clang = process.env.CLANG || 'clang';
  const result = spawnSync(clang, [
    '--target=aarch64-unknown-linux-gnu', '-fwrapv', opt, '-S', '-fno-asynchronous-unwind-tables', '-o', '-', sourcePath,
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return result.status === 0 ? { ok: true, asm: result.stdout } : { ok: false, error: String(result.stderr || 'clang failed').slice(0, 500) };
}

const names = Object.keys(specs);
const results = [];
for (const opt of optimizations) {
  const compiled = compileAssembly(opt);
  if (!compiled.ok) {
    results.push({ optimization: opt, skipped: true, reason: compiled.error });
    continue;
  }
  const rows = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const model = parseFunction(compiled.asm, name, 0x400000n + BigInt(i) * 0x10000n);
    assert.ok(model, `${opt} ${name}: assembly not parsed`);
    const rowMap = new Map(model.instructions.map((ins) => [ins.address.toString(), ins.row]));
    const result = decompile(model, {
      name,
      addr: model.instructions[0].address,
      rowOfAddress: (addr) => rowMap.get(addr?.toString()) ?? null,
      decompilerTimeBudgetMs: 180,
    });
    assert.ok(result?.semantic, `${opt} ${name}: semantic path fell back`);
    assert.ok(result.semanticAst && result.cAst, `${opt} ${name}: AST missing`);
    assert.ok(result.sourceMap?.length, `${opt} ${name}: source map missing`);
    const truth = semanticTruth(name, result);
    assert.equal(truth.equivalent, true, `${opt} ${name}: ${JSON.stringify(truth)}`);
    assert.equal(result.metrics?.rawAssemblyFallbacks || 0, 0, `${opt} ${name}: raw assembly fallback`);
    rows.push({
      function: name,
      semanticTruth: truth,
      rawAssemblyFallbacks: result.metrics?.rawAssemblyFallbacks || 0,
      gotos: result.metrics?.gotos || 0,
      rewrites: result.metrics?.rewrittenExpressions || 0,
      lines: String(result.pseudocode || '').split(/\r?\n/).length,
    });
  }
  results.push({ optimization: opt, functions: rows });
}

function ghidraFunction(map, name) { return map?.[name] || map?.['_' + name] || null; }

function ghidraDifferential() {
  const availability = ghidraAvailability();
  if (!availability.available) return { status: 'skipped', reason: availability.reason };
  const clang = process.env.CLANG || 'clang';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-compiler-truth-extended-'));
  try {
    const object = path.join(tmp, 'extended.o');
    const compile = spawnSync(clang, [
      '--target=aarch64-unknown-linux-gnu', '-fwrapv', '-O2', '-c', '-o', object, sourcePath,
    ], { encoding: 'utf8' });
    if (compile.status !== 0) return { status: 'failed', reason: String(compile.stderr || 'clang object compile failed').slice(0, 500) };
    const ghidra = runGhidra(object, { timeoutMs: 180000 });
    if (ghidra.status !== 'ok') return ghidra;
    const missing = names.filter((name) => !ghidraFunction(ghidra.functions, name));
    if (missing.length) return { status: 'failed', reason: 'Ghidra output missing expected functions', missing, parsed: ghidra.count || 0 };
    const o2 = results.find((row) => row.optimization === '-O2')?.functions || [];
    return {
      status: 'ok',
      parsed: ghidra.count,
      expected: names.length,
      note: 'Source execution is semantic ground truth; Ghidra is a differential readability reference only.',
      functions: names.map((name) => ({
        function: name,
        hex: o2.find((row) => row.function === name) || null,
        ghidra: readabilityMetrics(ghidraFunction(ghidra.functions, name)),
      })),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const ghidra = ghidraDifferential();
if (ghidraAvailability().available) {
  assert.equal(ghidra.status, 'ok', `extended Ghidra differential failed: ${JSON.stringify(ghidra)}`);
  assert.equal(ghidra.parsed, names.length, `extended Ghidra parsed ${ghidra.parsed}/${names.length}`);
}

const executed = results.flatMap((row) => row.functions || []).length;
assert.equal(executed, names.length * optimizations.length, `extended compiler truth executed ${executed}/${names.length * optimizations.length}`);
console.log('COMPILER_TRUTH_EXTENDED ' + JSON.stringify({ functions: names.length, optimizations, executed, ghidra, results }));
