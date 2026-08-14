import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseOperands } from '../../js/arm64.js';
import { decompile } from '../../js/decompile.js';
import { evaluateExpression } from '../../js/decompiler/verify/equivalence.js';
import { s, u } from '../../js/decompiler/truth/integer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.join(here, 'sources');
const optimizations = ['-O0','-O1','-O2','-O3','-Os','-Oz'];
const clangTargets = ['arm64-apple-ios13.0', 'aarch64-unknown-linux-gnu'];
const boundary32 = [0n, 1n, -1n, 2n, -2n, 0x7fffffffn, 0x80000000n, 0xffffffffn, 0x12345678n];

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

function parseFunction(asm, fn, baseAddress) {
  const all = asm.split(/\r?\n/);
  const names = new Set([`${fn}:`, `_${fn}:`]);
  const start = all.findIndex((line) => names.has(codeText(line).replace(/^"|"$/g, '')));
  if (start < 0) return null;
  let end = all.length;
  for (let i = start + 1; i < all.length; i++) {
    const code = codeText(all[i]).replace(/^"|"$/g, '');
    if (/^\.Lfunc_end\d+:/.test(code) || /^Lfunc_end\d+:/.test(code)) { end = i; break; }
    if (/^\.(?:cfi_endproc|subsections_via_symbols)/.test(code)) { end = i; break; }
  }
  const raw = [], labels = new Map();
  let row = 0;
  for (let i = start + 1; i < end; i++) {
    const text = codeText(all[i]);
    if (!text) continue;
    const label = /^([.]?L[\w.$]+):/.exec(text);
    if (label) { labels.set(label[1], row); continue; }
    if (text.startsWith('.') || text.startsWith('//') || text.startsWith('#')) continue;
    const match = /^([A-Za-z][\w.]*)\s*(.*)$/.exec(text);
    if (!match) continue;
    raw.push({ row: row++, mnemonic: match[1].toLowerCase(), operands: match[2].trim() });
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
      branchTarget: targetRow == null ? null : addressOfRow(targetRow), callTarget: null,
      memory: memoryInfo(mn, ops), reads: [], writes: [], data: false,
    };
  });
  const starts = new Set([0]);
  for (const ins of instructions) {
    if (ins.branchTarget != null) starts.add(Number((ins.branchTarget - baseAddress) / 4n));
    if ((ins.isBranch || ins.isReturn) && ins.row + 1 < instructions.length) starts.add(ins.row + 1);
  }
  const sorted = [...starts].filter((x) => x >= 0 && x < instructions.length).sort((a,b) => a-b);
  const basicBlocks = sorted.map((startRow, i) => ({
    startRow,
    endRow: (sorted[i + 1] ?? instructions.length) - 1,
    rows: Array.from({ length:(sorted[i + 1] ?? instructions.length) - startRow }, (_x,k) => startRow + k),
  }));
  return { name: fn, instructions, basicBlocks, semantic: [], calls: [] };
}

function compileClang(source, language, opt) {
  const clang = process.env.CLANG || 'clang';
  const version = spawnSync(clang, ['--version'], { encoding:'utf8' });
  if (version.status !== 0) return { available:false, reason:'clang unavailable' };
  const languageFlags = language === 'c++'
    ? ['-x','c++','-std=c++17','-fno-exceptions','-fno-rtti']
    : language === 'objective-c'
      ? ['-x','objective-c']
      : ['-x','c'];
  let last = null;
  for (const target of clangTargets) {
    const args = [`--target=${target}`, ...languageFlags, opt, '-S', '-fno-asynchronous-unwind-tables', '-o', '-', source];
    const run = spawnSync(clang, args, { encoding:'utf8', maxBuffer:16*1024*1024 });
    if (run.status === 0 && run.stdout) return { available:true, asm:run.stdout, target, version:(version.stdout || '').split(/\r?\n/)[0] };
    last = (run.stderr || `clang ${language} target unavailable`).trim().slice(0, 400);
  }
  return { available:false, reason:last || `clang ${language} unavailable` };
}

function verifyClamp(asm, fn, baseAddress) {
  const model = parseFunction(asm, fn, baseAddress);
  assert.ok(model, `${fn}: function assembly not parsed`);
  const rowMap = new Map(model.instructions.map((x) => [x.address.toString(), x.row]));
  const result = decompile(model, {
    name: fn, addr:model.instructions[0].address,
    rowOfAddress:(address) => rowMap.get(address?.toString()) ?? null,
    decompilerTimeBudgetMs:120,
  });
  assert.ok(result?.semantic, `${fn}: semantic decompiler fallback`);
  assert.ok(result.semanticAst && result.cAst && result.sourceMap?.length, `${fn}: AST/source map missing`);
  const ret = result.semanticAst.outputs?.find((x) => x.name === 'return')?.expression;
  assert.ok(ret, `${fn}: return semantic expression missing`);
  const inputs = result.semanticAst.inputs || [];
  let checked = 0;
  for (const input of boundary32) {
    const env = { arg1:input, a1:input };
    for (const item of inputs) env[item.name] = input;
    const actual = evaluateExpression(ret, env);
    assert.notEqual(actual, null, `${fn}: expression not executable for ${input}`);
    const expected = s(input, 32) < 0n ? 0n : u(input, 32);
    assert.equal(u(actual, 32), u(expected, 32), `${fn}: semantic mismatch for ${input}`);
    checked++;
  }
  return {
    checked,
    semantic:true,
    rawAssemblyFallbacks:result.metrics?.rawAssemblyFallbacks ?? null,
    gotos:result.metrics?.gotos ?? null,
    rewrites:result.metrics?.rewrittenExpressions ?? 0,
  };
}

function runClangLanguage(name, language, filename, functionName, baseAddress) {
  const source = path.join(sourceDir, filename);
  assert.ok(fs.existsSync(source), `${name}: fixture missing`);
  const rows = [];
  for (const opt of optimizations) {
    const compiled = compileClang(source, language, opt);
    assert.ok(compiled.available, `${name} ${opt}: ${compiled.reason}`);
    const truth = verifyClamp(compiled.asm, functionName, baseAddress + BigInt(rows.length) * 0x10000n);
    rows.push({ optimization:opt, target:compiled.target, ...truth });
  }
  return { status:'ok', language, fixture:filename, executed:rows.length, semanticChecks:rows.reduce((n,x) => n + x.checked, 0), rows };
}

function runSwiftOptional() {
  const swiftc = process.env.SWIFTC || 'swiftc';
  const version = spawnSync(swiftc, ['--version'], { encoding:'utf8' });
  if (version.status !== 0) return { status:'skipped', reason:'swiftc unavailable' };
  const source = path.join(sourceDir, 'scalars.swift');
  const rows = [];
  const swiftOpts = { '-O0':'-Onone', '-O1':'-O', '-O2':'-O', '-O3':'-Ounchecked', '-Os':'-Osize', '-Oz':'-Osize' };
  for (const opt of optimizations) {
    const args = ['-target','aarch64-unknown-linux-gnu', swiftOpts[opt], '-emit-assembly', '-o', '-', source];
    const run = spawnSync(swiftc, args, { encoding:'utf8', maxBuffer:16*1024*1024 });
    if (run.status !== 0) return { status:'skipped', reason:(run.stderr || 'Swift AArch64 cross target unavailable').trim().slice(0,400), completed:rows.length };
    assert.ok(/swiftClampI32/.test(run.stdout || ''), `Swift ${opt}: fixture symbol missing`);
    rows.push({ optimization:opt, target:'aarch64-unknown-linux-gnu', assembly:true });
  }
  return { status:'ok', language:'swift', fixture:'scalars.swift', executed:rows.length, rows };
}

const cpp = runClangLanguage('C++', 'c++', 'scalars.cpp', 'cpp_clamp_i32', 0x310000n);
const objc = runClangLanguage('Objective-C', 'objective-c', 'scalars.m', 'objc_clamp_i32', 0x410000n);
const swift = runSwiftOptional();
const summary = { optimizations, cpp, objc, swift };
console.log('COMPILER_TRUTH_LANGUAGES ' + JSON.stringify(summary));
assert.equal(cpp.executed, optimizations.length);
assert.equal(objc.executed, optimizations.length);
assert.equal(cpp.semanticChecks, optimizations.length * boundary32.length);
assert.equal(objc.semanticChecks, optimizations.length * boundary32.length);
