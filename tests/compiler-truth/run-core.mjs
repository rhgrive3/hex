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
const sourcePath = path.join(here, 'sources', 'scalars.c');
const expected = JSON.parse(fs.readFileSync(path.join(here, 'expected.json'), 'utf8'));
const opts = ['-O0','-O1','-O2','-O3','-Os','-Oz'];

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

function codeText(line) { return String(line || '').replace(/\/\/.*$/, '').trim(); }

function parseFunction(asm, fn, baseAddress = 0x100000n) {
  const all = asm.split(/\r?\n/);
  const start = all.findIndex((l) => codeText(l) === `${fn}:`);
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
    const t = codeText(all[i]);
    if (!t) continue;
    const lm = /^(\.L[\w.$]+):/.exec(t);
    if (lm) { labels.set(lm[1], row); continue; }
    if (t.startsWith('.') || t.startsWith('//') || t.startsWith('#')) continue;
    const m = /^([A-Za-z][\w.]*)\s*(.*)$/.exec(t);
    if (!m) continue;
    raw.push({ row: row++, mnemonic: m[1].toLowerCase(), operands: m[2].trim() });
  }
  if (!raw.length) return null;
  const addressOfRow = (r) => baseAddress + BigInt(r) * 4n;
  const instructions = raw.map((r) => {
    const ops = parseOperands(r.operands);
    const mn = r.mnemonic;
    const targetText = r.operands.split(',').at(-1)?.trim();
    const targetRow = labels.get(targetText);
    const conditional = /^b\.[a-z]{2}$/.test(mn) || /^(?:cbz|cbnz|tbz|tbnz)$/.test(mn);
    const branch = mn === 'b' || mn === 'br' || conditional;
    const call = mn === 'bl' || mn === 'blr';
    return {
      ...r, ops, address: addressOfRow(r.row),
      isReturn: mn === 'ret', isBranch: branch, isConditional: conditional, isCall: call,
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
  const sorted = [...starts].filter((x) => x >= 0 && x < instructions.length).sort((a,b) => a-b);
  const basicBlocks = sorted.map((s0, i) => ({ startRow:s0, endRow:(sorted[i+1] ?? instructions.length)-1, rows:Array.from({length:(sorted[i+1] ?? instructions.length)-s0},(_,k)=>s0+k) }));
  return { name: fn, instructions, basicBlocks, semantic: [], calls: [] };
}

function checkExpected(fn, result, enforceReadability = false) {
  assert.ok(result, `${fn}: no decompiler result`);
  assert.ok(result.semantic, `${fn}: semantic path unexpectedly fell back`);
  const text = result.pseudocode || '';
  const e = expected[fn];
  const readabilityPass = (e.mustContain || []).every((token) => text.includes(token)) && (!e.mustContainAny || e.mustContainAny.some((x) => text.includes(x)));
  if (enforceReadability) assert.ok(readabilityPass, `${fn}: optimized readability expectation missed\n${text}`);
  assert.ok(result.semanticAst, `${fn}: semantic AST missing`);
  assert.ok(result.cAst, `${fn}: C AST missing`);
  assert.ok(Array.isArray(result.sourceMap) && result.sourceMap.length, `${fn}: source map missing`);
  const truth = semanticTruth(fn, result);
  assert.equal(truth.equivalent, true, `${fn}: semantic truth unavailable/mismatched ${JSON.stringify(truth)}`);
  return { function: fn, semantic: e.semantic, semanticTruth: truth, readabilityPass, asmFallbacks: result.metrics?.rawAssemblyFallbacks ?? null, gotos: result.metrics?.gotos ?? null, rewrites: result.metrics?.rewrittenExpressions ?? 0 };
}

function compileWithClang(opt) {
  const clang = process.env.CLANG || 'clang';
  const ver = spawnSync(clang, ['--version'], { encoding:'utf8' });
  if (ver.status !== 0) return { available:false, reason:'clang unavailable' };
  const r = spawnSync(clang, ['--target=aarch64-unknown-linux-gnu', opt, '-S', '-fno-asynchronous-unwind-tables', '-o', '-', sourcePath], { encoding:'utf8', maxBuffer:16*1024*1024 });
  if (r.status !== 0) return { available:false, reason:(r.stderr || 'AArch64 clang target unavailable').trim().slice(0,240) };
  return { available:true, asm:r.stdout, version:(ver.stdout || '').split(/\r?\n/)[0] };
}

const truthFns = {
  max_i32: (a,b) => u(s(a,32) > s(b,32) ? a : b, 32),
  min_i32: (a,b) => u(s(a,32) < s(b,32) ? a : b, 32),
  clamp0_i32: (a) => u(s(a,32) < 0n ? 0n : a, 32),
  extract8: (a) => u(u(a,32) >> 8n, 8),
  muladd_i32: (a,b,c) => u(u(a,32) * u(b,32) + u(c,32), 32),
  bool_i32: (a,b) => u(a,32) === u(b,32) ? 1n : 0n,
};
const truthCases = [0n,1n,-1n,2n,-2n,0x7fffffffn,0x80000000n,0xffffffffn,0x12345678n];

function semanticTruth(fn, result) {
  const ret = result?.semanticAst?.outputs?.find((x) => x.name === 'return')?.expression;
  if (!ret || !truthFns[fn]) return { checked:0, equivalent:null, reason:'return expression unavailable' };
  const inputs = result.semanticAst.inputs || [];
  let checked = 0;
  for (let i=0;i<truthCases.length;i++) {
    const args = inputs.map((_x,j) => truthCases[(i+j*2) % truthCases.length]);
    const env = {};
    for (let j=0;j<inputs.length;j++) env[inputs[j].name] = args[j];
    for (let j=0;j<args.length;j++) { env[`arg${j+1}`] = args[j]; env[`a${j+1}`] = args[j]; }
    const actual = evaluateExpression(ret, env);
    if (actual == null) continue;
    const expectedValue = truthFns[fn](...args);
    checked++;
    const width = fn === 'extract8' ? 8 : 32;
    if (u(actual,width) !== u(expectedValue,width)) return { checked, equivalent:false, counterexample:{ env, actual:String(actual), expected:String(expectedValue) } };
  }
  return { checked, equivalent: checked ? true : null };
}

const functions = Object.keys(expected);
const results = [];
let clangAvailable = true;
let clangVersion = null;
for (const opt of opts) {
  const compiled = compileWithClang(opt);
  if (!compiled.available) { clangAvailable = false; results.push({ optimization:opt, skipped:true, reason:compiled.reason }); continue; }
  clangVersion ||= compiled.version;
  const perFunction = [];
  for (let i = 0; i < functions.length; i++) {
    const fn = functions[i];
    const model = parseFunction(compiled.asm, fn, 0x100000n + BigInt(i) * 0x10000n);
    if (!model) { perFunction.push({ function:fn, failure:'function assembly not parsed' }); continue; }
    try {
      const rowMap = new Map(model.instructions.map((x) => [x.address.toString(), x.row]));
      const returnType = fn === 'extract8' || fn === 'bool_i32' ? 'uint32' : 'int32';
      const result = decompile(model, { name:fn, addr:model.instructions[0].address, rowOfAddress:(a)=>rowMap.get(a?.toString()) ?? null, returnType, decompilerTimeBudgetMs:120 });
      perFunction.push(checkExpected(fn, result, opt === '-O2' || opt === '-O3'));
    } catch (error) {
      perFunction.push({ function:fn, failure:error?.message || String(error) });
    }
  }
  results.push({ optimization:opt, functions:perFunction });
}

const prebuiltAsm = `
max_prebuilt:
  cmp w0, w1
  csel w0, w0, w1, gt
  ret
`;
const prebuilt = parseFunction(prebuiltAsm, 'max_prebuilt', 0x200000n);
assert.ok(prebuilt);
const preMap = new Map(prebuilt.instructions.map((x) => [x.address.toString(), x.row]));
const preResult = decompile(prebuilt, { name:'max_prebuilt', addr:0x200000n, returnType:'int32', rowOfAddress:(a)=>preMap.get(a?.toString()) ?? null, decompilerTimeBudgetMs:120 });
assert.ok(preResult.semanticAst && preResult.cAst && preResult.sourceMap?.length, 'prebuilt compiler-truth pipeline missing AST/source map');
assert.match(preResult.pseudocode, /max\(/, `prebuilt max recovery failed\n${preResult.pseudocode}`);
const preTruth = semanticTruth('max_i32', preResult);
assert.equal(preTruth.equivalent, true, JSON.stringify(preTruth));

function ghidraFunction(functionsMap, name) {
  return functionsMap?.[name] || functionsMap?.['_' + name] || null;
}

function optionalGhidraComparison() {
  const availability = ghidraAvailability();
  if (!availability.available) return { status:'skipped', reason:availability.reason };
  const clang = process.env.CLANG || 'clang';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-compiler-truth-'));
  try {
    const obj = path.join(tmp, 'scalars.o');
    const c = spawnSync(clang, ['--target=aarch64-unknown-linux-gnu','-O2','-c','-o',obj,sourcePath], {encoding:'utf8'});
    if (c.status !== 0) return { status:'skipped', reason:'AArch64 object compilation unavailable for Ghidra differential' };
    const g = runGhidra(obj, { timeoutMs:180000 });
    if (g.status !== 'ok') return g;
    const missing = functions.filter((fn) => !ghidraFunction(g.functions, fn));
    if (missing.length) {
      return {
        status:'failed',
        reason:'Ghidra did not return every compiler-truth function',
        expected:functions.length,
        parsed:g.count || 0,
        missing,
        availableNames:Object.keys(g.functions || {}).slice(0, 50),
        diagnostics:g.diagnostics || null,
      };
    }
    const o2 = results.find((r)=>r.optimization==='-O2')?.functions || [];
    const rows=[];
    for (const fn of functions) {
      const hex = o2.find((x)=>x.function===fn) || null;
      const gt = ghidraFunction(g.functions, fn);
      const e=expected[fn];
      const ghidraReadable = (e.mustContain || []).every((t)=>gt.includes(t)) && (!e.mustContainAny || e.mustContainAny.some((t)=>gt.includes(t)));
      const hexCorrect = hex?.semanticTruth?.equivalent === true;
      const classification = hexCorrect && ghidraReadable ? 'both-correct-or-readable'
        : hexCorrect && !ghidraReadable ? 'hex-correct-ghidra-readability-miss'
          : !hexCorrect && ghidraReadable ? 'ghidra-readable-hex-unverified'
            : 'both-unverified';
      rows.push({ function:fn, classification, hex, ghidra:readabilityMetrics(gt) });
    }
    return { status:'ok', parsed:g.count, expected:functions.length, note:'source manifests are ground truth; Ghidra token/readability checks are not treated as semantic oracle', functions:rows };
  } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
}

const ghidra = optionalGhidraComparison();
const hardFailures = results.flatMap((r) => r.functions || []).filter((x) => x.failure);
const executed = results.flatMap((r) => r.functions || []).filter((x) => !x.failure && !x.skipped).length;
const summary = { clangAvailable, clangVersion, optimizations:opts, executed, expectedCases: clangAvailable ? opts.length * functions.length : 0, hardFailures:hardFailures.length, ghidra, results, prebuilt:{ pass:true, semanticTruth:preTruth, rewrites:preResult.metrics?.rewrittenExpressions || 0 } };
console.log('COMPILER_TRUTH ' + JSON.stringify(summary));
if (clangAvailable) {
  assert.equal(hardFailures.length, 0, JSON.stringify(hardFailures, null, 2));
  assert.equal(executed, opts.length * functions.length, `compiler-truth executed ${executed}/${opts.length * functions.length}`);
}
if (ghidraAvailability().available) {
  assert.equal(ghidra.status, 'ok', `mandatory Ghidra differential failed: ${JSON.stringify(ghidra)}`);
  assert.equal(ghidra.parsed, functions.length, `Ghidra differential parsed ${ghidra.parsed}/${functions.length}`);
}