import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { openBinary } from '../harness.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt = '') => {
  const p = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : dflt;
};
const TARGET = opt('target');
const ORACLE = opt('oracle');
const NAME = opt('name', path.basename(TARGET));
const OUT = opt('out', `diagnostics-${NAME}.json`);
if (!TARGET || !ORACLE) throw new Error('usage: --target=... --oracle=...');

const raw = fs.readFileSync(ORACLE);
const oracle = JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
const world = await openBinary(TARGET, { log: (s) => console.error(`[${NAME}] ${s}`) });
const hex = (n) => '0x' + Number(n).toString(16);
const stride = (list, n) => {
  if (list.length <= n) return list.slice();
  const out = [], step = list.length / n;
  for (let i = 0; i < n; i++) out.push(list[Math.floor(i * step)]);
  return out;
};
const pct = (n, d) => d ? n / d : null;

const chunkCache = new Map();
async function insnAt(addr) {
  const vm = Number(world.region.vmAddr);
  const row = Math.floor((Number(addr) - vm) / 4);
  if (row < 0) return null;
  const chunk = Math.floor(row / 1024);
  if (!chunkCache.has(chunk)) chunkCache.set(chunk, world.backend.fetchChunk(world.region.id, chunk, true));
  const got = await chunkCache.get(chunk);
  const i = row % 1024;
  if (!got || !got.mn || i >= got.mn.length) return null;
  return { addr: hex(addr), mn: (got.mn[i] || '').trim(), ops: (got.ops[i] || '').trim() };
}
async function contextAt(addr, radius = 2) {
  const out = [];
  for (let i = -radius; i <= radius; i++) {
    const r = await insnAt(Number(addr) + i * 4);
    if (r) out.push(r);
  }
  return out;
}
function nearestTruth(addr, starts) {
  let lo = 0, hi = starts.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (starts[m] < addr) lo = m + 1; else hi = m;
  }
  return {
    prev: lo ? { addr: hex(starts[lo - 1]), delta: addr - starts[lo - 1] } : null,
    next: lo < starts.length ? { addr: hex(starts[lo]), delta: starts[lo] - addr } : null,
  };
}

async function diagnoseFunctionGuess() {
  const res = await world.backend.guessFunctions(world.region.id, 400000);
  const got = Array.from(res.starts || res.addrs || [], Number);
  const truth = oracle.functionStarts.map(Number);
  const truthSet = new Set(truth), gotSet = new Set(got);
  const fp = got.filter((a) => !truthSet.has(a));
  const fn = truth.filter((a) => !gotSet.has(a));
  const tp = got.length - fp.length;
  const sampled = stride(fp, 1500);
  const directCallTargets = new Set(oracle.calls.map((x) => Number(x[1])));
  const hist = new Map();
  const source = { directCallTarget: 0, afterRet: 0, afterBranch: 0, afterIndirectBranch: 0, afterTrap: 0, other: 0 };
  for (const a of sampled) {
    const prev = await insnAt(a - 4), cur = await insnAt(a);
    const key = `${prev?.mn || '?'} -> ${cur?.mn || '?'}`;
    hist.set(key, (hist.get(key) || 0) + 1);
    if (directCallTargets.has(a)) source.directCallTarget++;
    else if (prev?.mn === 'ret' || prev?.mn === 'retab' || prev?.mn === 'retaa') source.afterRet++;
    else if (prev?.mn === 'b') source.afterBranch++;
    else if (prev?.mn === 'br') source.afterIndirectBranch++;
    else if (prev?.mn === 'brk' || prev?.mn === 'udf') source.afterTrap++;
    else source.other++;
  }
  const examples = [];
  for (const a of stride(fp, 16)) examples.push({ addr: hex(a), nearestTruth: nearestTruth(a, truth), context: await contextAt(a) });
  const missed = [];
  for (const a of stride(fn, 16)) missed.push({ addr: hex(a), context: await contextAt(a) });
  return {
    tp, fp: fp.length, fn: fn.length, got: got.length, truth: truth.length,
    precision: pct(tp, got.length), recall: pct(tp, truth.length),
    capped: !!res.capped, truncationReason: res.truncationReason || null,
    sampledFalsePositiveSources: source,
    topFalsePositiveTransitions: [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([pattern, count]) => ({ pattern, count })),
    falsePositiveExamples: examples,
    falseNegativeExamples: missed,
  };
}

async function diagnoseKinds() {
  const { KIND } = await import('../../js/program.js');
  const names = Object.keys(KIND);
  const vm = Number(world.region.vmAddr);
  const rows = [];
  for (const [addr, mn, ops] of oracle.sampleInsns) {
    if (!(mn === 'bics' || (mn === 'ldr' && !ops.includes('[')))) continue;
    const row = (addr - vm) / 4;
    if (!Number.isInteger(row) || row < 0 || row >= world.scan.kindsCovered) continue;
    rows.push({ addr: hex(addr), oracleMnemonic: mn, operands: ops, semanticKind: names[world.scan.kinds[row]] });
  }
  return rows;
}

async function diagnoseRefs() {
  const truth = new Map(Object.entries(oracle.adrTargets).map(([k, v]) => [Number(k), Number(v)]));
  const got = new Map();
  for (let i = 0; i < world.scan.refFrom.length; i++) {
    const from = Number(world.scan.refFrom[i]);
    if (!truth.has(from)) continue;
    if (!got.has(from)) got.set(from, []);
    got.get(from).push(Number(world.scan.refTo[i]));
  }
  const missing = [], wrong = [];
  for (const [site, want] of truth) {
    const values = got.get(site);
    if (!values) missing.push({ site, want });
    else if (!values.includes(want)) wrong.push({ site, want, got: values });
  }
  const decorate = async (x) => ({
    site: hex(x.site), want: hex(x.want), got: x.got?.map(hex) || null,
    context: await contextAt(x.site),
  });
  const missExamples = [];
  for (const x of missing.slice(0, 24)) missExamples.push(await decorate(x));
  const wrongExamples = [];
  for (const x of wrong.slice(0, 24)) wrongExamples.push(await decorate(x));
  return { truth: truth.size, missing: missing.length, wrong: wrong.length, missingExamples: missExamples, wrongExamples };
}

function diagnoseObjcAndFields() {
  if (!oracle.objcClasses?.length) return { applicable: false };
  const got = new Map((world.objcModel?.classes || []).map((c) => [c.name, c]));
  const ivarProblems = [];
  for (const c of oracle.objcClasses) {
    const g = got.get(c.name);
    const gi = new Map((g?.ivars || []).map((i) => [i.name, i]));
    for (const iv of c.ivars) {
      const h = gi.get(iv.name);
      const ok = h && ((h.offset == null && iv.offset == null) || Number(h.offset) === iv.offset);
      if (!ok) {
        const field = iv.offset == null ? null : world.fields.fieldAt(c.name, iv.offset);
        ivarProblems.push({
          className: c.name, ivar: iv.name, expectedOffset: iv.offset,
          parsedOffset: h?.offset == null ? null : Number(h.offset),
          fieldIndex: field ? { exact: !!field.exact, name: field.field?.name || null, offset: field.field?.offset == null ? null : Number(field.field.offset) } : null,
        });
      }
    }
  }
  return { applicable: true, ivarProblems, count: ivarProblems.length };
}

async function diagnoseApiMeaning() {
  const { apiInfo } = await import('../../js/blocks.js');
  const stubUse = new Map();
  for (const t0 of world.scan.callTo) {
    const t = Number(t0);
    if (oracle.stubs[t] || oracle.objcStubs[t]) stubUse.set(t, (stubUse.get(t) || 0) + 1);
  }
  const unknown = [];
  let knownCalls = 0, totalCalls = 0;
  for (const [addr, count] of stubUse) {
    totalCalls += count;
    const name = oracle.stubs[addr] || ('objc_msgSend$' + oracle.objcStubs[addr]);
    if (apiInfo(name)) knownCalls += count;
    else unknown.push({ name, count, stub: hex(addr) });
  }
  unknown.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { knownCalls, totalCalls, missingCalls: totalCalls - knownCalls, unknownApiCount: unknown.length, unknown: unknown.slice(0, 80) };
}

async function diagnoseSummary() {
  if (!oracle.objcClasses?.length) return { applicable: false };
  const { functionStory, apiShort } = await import('../../js/narrate.js');
  const { apiInfo } = await import('../../js/blocks.js');
  const named = [];
  for (const c of oracle.objcClasses) for (const m of c.methods) named.push(m.addr);
  const plumbing = /^_+(objc_(retain|release|autorelease|storeStrong|storeWeak|loadWeak|destroyWeak|initWeak|copyWeak|moveWeak|sync_|enumerationMutation|begin_catch|end_catch|opt_|msgSend$|exception)|swift_|_?cxa_|Block_|Unwind_|Z[dn]|stack_chk|dyld)/;
  const callsBySrc = new Map();
  for (const [src, dst] of oracle.calls) {
    const name = oracle.stubs[dst] || (oracle.objcStubs[dst] ? 'objc:' + oracle.objcStubs[dst] : null);
    if (name && !plumbing.test(name)) callsBySrc.set(src, name);
  }
  const starts = oracle.functionStarts, idx = new Map(starts.map((a, i) => [a, i]));
  const withApi = named.filter((a) => idx.has(a)).filter((a) => {
    const i = idx.get(a), end = starts[i + 1] || a + 64;
    for (let p = a; p < end; p += 4) if (callsBySrc.has(p)) return true;
    return false;
  });
  const samples = stride(withApi, 200);
  const failures = [];
  let hit = 0, judged = 0;
  for (const a of samples) {
    const i = idx.get(a), end = starts[i + 1] || a + 256;
    const want = new Set();
    for (let p = a; p < end; p += 4) if (callsBySrc.has(p)) want.add(callsBySrc.get(p));
    const model = await world.analyze(BigInt(a), BigInt(end));
    if (!model) continue;
    judged++;
    const story = functionStory(model, world.symbols.nameAt(BigInt(a))) || [];
    const text = JSON.stringify(story);
    const matched = [], missed = [];
    for (const nm of want) {
      const core = nm.replace(/^objc:/, '').replace(/^_+/, '').replace(/:.*$/, '');
      let ok = core.length >= 4 && text.includes(core);
      if (!ok) {
        const info = apiInfo(nm.replace(/^objc:/, ''));
        const phrase = info ? apiShort(info.id) : null;
        ok = !!(phrase && text.includes(phrase));
      }
      (ok ? matched : missed).push(nm);
    }
    const threshold = Math.min(5, Math.ceil(want.size / 2));
    if (matched.length >= threshold) hit++;
    else if (failures.length < 12) failures.push({ addr: hex(a), name: world.symbols.nameAt(BigInt(a)), threshold, matched, missed, story });
  }
  return { applicable: true, hit, judged, failures };
}

async function diagnosePseudoc() {
  if (NAME === 'BattleCats') return { skipped: true, reason: 'baseline is already 100%' };
  const { decompile } = await import('../../js/decompile.js');
  const starts = oracle.functionStarts;
  const cands = [];
  for (let i = 0; i < starts.length - 1; i++) {
    const size = starts[i + 1] - starts[i];
    if (size >= 64 && size <= 2048) cands.push([starts[i], starts[i + 1]]);
  }
  const samples = stride(cands, 120);
  const failures = [];
  let lines = 0, asmLines = 0, done = 0;
  for (const [a, end] of samples) {
    const model = await world.analyze(BigInt(a), BigInt(end));
    if (!model) continue;
    let res;
    try {
      res = decompile(model, {
        addr: BigInt(a),
        rowOfAddress: (x) => x == null ? null : Number((x - world.region.vmAddr) / 4n),
        addrOfRow: (r) => world.region.vmAddr + BigInt(r) * 4n,
        symbolFor: (x) => world.symbols.nameAt(x),
      });
    } catch (err) {
      failures.push({ function: hex(a), error: String(err?.message || err) });
      continue;
    }
    done++;
    const untranslated = [];
    for (const l of res.lines) {
      if (l.kind !== 'stmt' && l.kind !== 'ctrl') continue;
      lines++;
      if (/__asm\(/.test(l.text) && !/__asm\("br\s+x\d+"\)/.test(l.text)) {
        asmLines++;
        untranslated.push(l.text);
      }
    }
    if (untranslated.length) failures.push({ function: hex(a), name: world.symbols.nameAt(BigInt(a)), untranslated });
  }
  return { done, lines, asmLines, failures };
}

const report = {
  target: NAME,
  fixture: TARGET,
  oracle: ORACLE,
  functionGuess: await diagnoseFunctionGuess(),
  kindEdgeCases: await diagnoseKinds(),
  refs: await diagnoseRefs(),
  objcAndFields: diagnoseObjcAndFields(),
  apiMeaning: await diagnoseApiMeaning(),
  summary: await diagnoseSummary(),
  pseudoc: await diagnosePseudoc(),
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
console.error(`[${NAME}] wrote ${OUT}`);
