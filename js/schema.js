/*
 * データファイルの表を、命令から読み取る層。
 * 名前ではなく命令の構造から列・stride・record shapeを復元する。
 */
import './words.js';

const W = globalThis.Words;
const rd = (w) => w & 31;
const rn = (w) => (w >>> 5) & 31;
const rm = (w) => (w >>> 16) & 31;

function addSubImm(w) {
  if (W.masked(w, 0x1f000000) !== 0x11000000) return null;
  if (((w >>> 29) & 1) === 1 && rd(w) === 31) return null;
  const imm = ((w >>> 10) & 0xfff) << (((w >>> 22) & 1) ? 12 : 0);
  return { d: rd(w), n: rn(w), imm, sub: ((w >>> 30) & 1) === 1 };
}

function moveWide(w) {
  if (!W.isMoveWide(w)) return null;
  const opc = (w >>> 29) & 3;
  const shift = ((w >>> 21) & 3) * 16;
  const imm16 = (w >>> 5) & 0xffff;
  if (opc === 2) return { d: rd(w), kind: 'movz', value: imm16 * 2 ** shift };
  if (opc === 3) return { d: rd(w), kind: 'movk', imm16, shift };
  return null;
}

function indexedAccess(w) {
  if (W.masked(w, 0x3b200c00) !== 0x38200800) return null;
  const size = 1 << ((w >>> 30) & 3);
  return { load: ((w >>> 22) & 1) === 1, size, base: rn(w), index: rm(w), reg: rd(w), stride: ((w >>> 12) & 1) === 1 ? size : 1 };
}

function plainAccess(w) {
  const m = W.memoryAccess(w);
  if (!m || m.indexed || m.pair || m.disp == null) return null;
  return { load: m.load, size: m.size, base: m.base, disp: Number(m.disp), reg: m.reg };
}

function writtenGpr(w) {
  const pcRel = W.pcRelTarget(w, 0n);
  if (pcRel) return pcRel.reg;
  const mw = moveWide(w);
  if (mw) return mw.d;
  const kind = W.classifyWord(w);
  if ([W.KIND.MOVREG, W.KIND.ARITH, W.KIND.MUL, W.KIND.DIV, W.KIND.LOGIC, W.KIND.SHIFT, W.KIND.CSEL].includes(kind)) return rd(w);
  if ((kind === W.KIND.LOAD || kind === W.KIND.LITERAL) && ((w >>> 26) & 1) === 0) return rd(w);
  return null;
}

const MAX_COLUMNS = 4096;
const MAX_RECORD = 1 << 20;

function writesRegister(w, reg) {
  const kind = W.classifyWord ? W.classifyWord(w) : null;
  // Stores, branches, compares, calls and returns do not write Rd as a normal
  // destination. Everything else that decodes with Rd==reg conservatively
  // invalidates prior value provenance.
  const noDest = new Set([
    W.KIND?.STORE, W.KIND?.CMP, W.KIND?.CONDBR, W.KIND?.BRANCH,
    W.KIND?.CALL, W.KIND?.INDCALL, W.KIND?.RET, W.KIND?.TRAP,
  ]);
  if (kind != null && noDest.has(kind)) return false;
  const mem = W.memoryAccess(w);
  if (mem?.load && mem.reg === reg) return true;
  if (mem && !mem.load) return false;
  if (W.isCallImm(w) || W.isIndirectCall(w)) return reg <= 18;
  if (W.compareImmediate(w) != null) return false;
  return rd(w) === reg;
}

export function decodeSchema(words, base) {
  const konst = new Int32Array(32).fill(0);
  const known = new Uint8Array(32);
  const bumped = [], loops = [], fixed = [], scales = [], cmps = [];
  const flow = controlContext(words, base);
  const baseGeneration = new Uint32Array(32);
  let lastCall = -1;

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const written = writtenGpr(w);
    if (written != null && written >= 0 && written < 31) baseGeneration[written]++;
    const mw = moveWide(w);
    if (mw) {
      if (mw.kind === 'movz') { konst[mw.d] = mw.value; known[mw.d] = 1; }
      else if (known[mw.d]) konst[mw.d] |= mw.imm16 * 2 ** mw.shift;
      if (mw.d === 0) lastCall = -1;
      continue;
    }

    const ci = W.compareImmediate(w);
    if (ci != null) { cmps.push({ reg: rn(w), value: Number(ci), row: i, loop: flow.loopOf[i] }); continue; }

    if (W.isCallImm(w) || W.isIndirectCall(w)) {
      lastCall = i;
      for (let r = 0; r <= 18; r++) { known[r] = 0; baseGeneration[r]++; }
      continue;
    }

    const as = addSubImm(w);
    if (as) {
      if (!as.sub && as.d === as.n && as.imm > 0) bumped.push({ reg: as.d, imm: as.imm, row: i, loop: flow.loopOf[i] });
      konst[as.d] = 0; known[as.d] = 0;
      if (as.d === 0) lastCall = -1;
      continue;
    }

    const ix = indexedAccess(w);
    if (ix) {
      if (ix.load) {
        scales.push({ row: i, base: ix.base, index: ix.index, stride: ix.stride, loadedReg: ix.reg, block: flow.blockOf[i], loop: flow.loopOf[i], mul: null });
        if (ix.reg === 0) lastCall = -1;
      } else {
        loops.push({
          row: i, addr: base + BigInt(i * 4), base: ix.base, index: ix.index, stride: ix.stride,
          size: ix.size, block: flow.blockOf[i], loop: flow.loopOf[i],
          fromCall: lastCall >= 0 && i - lastCall <= 3 && ix.reg === 0,
        });
      }
      continue;
    }

    const pa = plainAccess(w);
    if (pa) {
      if (!pa.load && pa.reg === 0 && lastCall >= 0 && i - lastCall <= 3 && pa.base !== 31) {
        fixed.push({
          row: i, addr: base + BigInt(i * 4), base: pa.base, disp: pa.disp, size: pa.size,
          block: flow.blockOf[i], loop: flow.loopOf[i], baseGeneration: baseGeneration[pa.base],
          fromCall: true, callRow: lastCall, callAddr: base + BigInt(lastCall * 4),
        });
      }
      if (pa.load && pa.reg === 0) lastCall = -1;
      continue;
    }

    if (W.isMultiply(w) && scales.length) {
      const last = scales[scales.length - 1];
      if (last.mul == null && i - last.row <= 6 && last.block === flow.blockOf[i] && (rn(w) === last.loadedReg || rm(w) === last.loadedReg)) {
        const other = rn(w) === last.loadedReg ? rm(w) : rn(w);
        const k = known[other] ? konst[other] : null;
        if (k) last.mul = k;
      }
      if (rd(w) === 0) lastCall = -1;
      continue;
    }

    // A nearby store of x0 is a call return only if x0 still contains that
    // exact return. Any intervening write invalidates provenance immediately.
    if (lastCall >= 0 && writesRegister(w, 0)) lastCall = -1;
  }

  return buildSchema({ loops, fixed, scales, cmps, bumped, base, words });
}

function fixedRegion(f) {
  if (f?.loop != null && f.loop >= 0) return `loop:${f.loop}`;
  if (f?.block != null && f.block >= 0) return `block:${f.block}`;
  return null;
}

function splitLocalRuns(list, maxGap = 16) {
  const sorted = list.slice().sort((a, b) => a.row - b.row);
  const runs = [];
  let run = [];
  for (const item of sorted) {
    if (run.length && item.row - run[run.length - 1].row > maxGap) { runs.push(run); run = []; }
    run.push(item);
  }
  if (run.length) runs.push(run);
  return runs;
}

export function unrolledTablesFromFixed(fixed) {
  const groups = new Map();
  for (const f of fixed || []) {
    const region = fixedRegion(f);
    if (!region || f.base == null || f.baseGeneration == null || f.callRow == null || f.fromCall !== true) continue;
    const key = `${region}:x${f.base}:v${f.baseGeneration}:s${f.size}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const tables = [];
  for (const list of groups.values()) {
    for (const run of splitLocalRuns(list)) {
      if (run.length < 3) continue;
      const sorted = run.slice().sort((a, b) => a.row - b.row);
      const offsets = sorted.map((f) => f.disp);
      const stride = offsets[1] - offsets[0];
      if (!(stride > 0) || offsets.some((off, i) => i > 0 && off - offsets[i - 1] !== stride)) continue;
      if (new Set(offsets).size !== offsets.length) continue;
      const region = fixedRegion(sorted[0]);
      tables.push({
        kind: 'unrolled', columns: offsets.length, columnStride: stride, columnSize: sorted[0].size,
        recordStride: null, records: null, consistent: true, fromCall: true,
        storeAddr: sorted[0].addr, offsets, scaled: [],
        provenance: {
          base: sorted[0].base, baseGeneration: sorted[0].baseGeneration, region,
          callRows: sorted.map((f) => f.callRow), callAddrs: sorted.map((f) => f.callAddr ?? null),
          storeRows: sorted.map((f) => f.row),
        },
        offsetOf(i) { return i >= 0 && i < offsets.length ? offsets[i] : null; },
      });
    }
  }
  return tables;
}

function buildSchema({ loops, fixed, scales, cmps, bumped, base }) {
  const tables = [];
  const seen = new Set();
  for (const l of loops) {
    const key = l.base + ':' + l.index + ':' + l.stride;
    if (seen.has(key)) continue;
    seen.add(key);
    const step = nearestFact(bumped, l.index, l, (x) => x.imm === 1);
    const bound = nearestFact(cmps, l.index, l, (x) => x.value > 1 && x.value <= MAX_COLUMNS);
    const columns = (step && step.imm === 1 && bound && bound.value > 1 && bound.value <= MAX_COLUMNS) ? bound.value : null;
    const rec = nearestFact(bumped, l.base, l, (x) => x.imm > l.stride && x.imm <= MAX_RECORD);
    const recordStride = rec && rec.imm > l.stride && rec.imm <= MAX_RECORD ? rec.imm : null;
    const consistent = columns != null && recordStride != null ? recordStride === columns * l.stride : null;
    tables.push(makeIndexedTable({ columns, stride: l.stride, size: l.size, recordStride, consistent, storeAddr: l.addr, records: recordCountOf(cmps, bumped, l), scaled: scaledColumns(scales, l), fromCall: l.fromCall }));
  }

  tables.push(...unrolledTablesFromFixed(fixed));

  if (!tables.length) return null;
  tables.sort((a, b) => (b.consistent === true) - (a.consistent === true) || (b.fromCall === true) - (a.fromCall === true) || (b.columns || 0) - (a.columns || 0));
  void base;
  return { tables, best: tables[0] };
}

function makeIndexedTable(t) {
  return {
    kind: 'indexed', columns: t.columns, columnStride: t.stride, columnSize: t.size,
    recordStride: t.recordStride, records: t.records, consistent: t.consistent,
    storeAddr: t.storeAddr, scaled: t.scaled, fromCall: t.fromCall,
    offsetOf(i) { if (!(i >= 0) || (t.columns != null && i >= t.columns)) return null; return i * t.stride; },
  };
}

function recordCountOf(cmps, bumped, table) {
  const candidates = cmps.filter((c) => c.reg !== table.base && c.reg !== table.index && c.value > 1 && c.value <= 4096 && sameLoopOrNearby(c, table));
  candidates.sort((a, b) => Math.abs(a.row - table.row) - Math.abs(b.row - table.row));
  for (const c of candidates) {
    const step = nearestFact(bumped, c.reg, c, (x) => x.imm === 1);
    if (step && sameLoopOrNearby(step, table)) return c.value;
  }
  return null;
}

function scaledColumns(scales, table) {
  const out = [];
  for (const s of scales) {
    if (s.mul == null || s.base !== table.base || s.index !== table.index || !sameLoopOrNearby(s, table)) continue;
    out.push({ factor: s.mul, columnStride: s.stride || table.stride, loadedReg: s.loadedReg });
  }
  return out;
}

function nearestFact(facts, reg, anchor, accept) {
  const list = facts.filter((x) => x.reg === reg && (!accept || accept(x)) && sameLoopOrNearby(x, anchor));
  list.sort((a, b) => Math.abs(a.row - anchor.row) - Math.abs(b.row - anchor.row));
  return list[0] || null;
}

function sameLoopOrNearby(a, b) {
  if (a.loop != null || b.loop != null) return a.loop != null && a.loop === b.loop;
  return Math.abs(a.row - b.row) <= 64;
}

function controlContext(words, base) {
  const leaders = new Set([0]), ranges = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i], pc = base + BigInt(i * 4);
    const target = (W.isCallImm(w) ? null : W.branchImm26(w, pc)) ?? W.condBranchTarget(w, pc);
    if (target != null) {
      const row = Number((target - base) / 4n);
      if (row >= 0 && row < words.length) leaders.add(row);
      if (i + 1 < words.length) leaders.add(i + 1);
      if (row >= 0 && row <= i) ranges.push({ start: row, end: i });
    }
  }
  const sorted = Array.from(leaders).sort((a, b) => a - b);
  const blockOf = new Int32Array(words.length);
  for (let b = 0; b < sorted.length; b++) {
    const end = b + 1 < sorted.length ? sorted[b + 1] : words.length;
    for (let i = sorted[b]; i < end; i++) blockOf[i] = b;
  }
  const loopOf = new Array(words.length).fill(null);
  ranges.sort((a, b) => (a.end - a.start) - (b.end - b.start));
  for (let id = 0; id < ranges.length; id++) for (let i = ranges[id].start; i <= ranges[id].end; i++) if (loopOf[i] == null) loopOf[i] = id;
  return { blockOf, loopOf };
}

export function looksLikeDataFile(text) { return /\.(csv|tsv|json|plist|dat|txt)$/i.test(String(text || '')); }

export async function recoverSchemas(opts) {
  const o = opts || {};
  const { strings, program, read } = o;
  if (!strings || !program || !read) return [];
  const limit = o.limit || 300;
  const cancelled = o.isCancelled || (() => false);
  const progress = o.onProgress || (() => {});
  const byFunction = new Map();
  for (const s of strings) {
    if (!looksLikeDataFile(s.text)) continue;
    const fns = program.functionsReferencing(s.addr, BigInt(Math.max(1, s.text.length)), 8);
    for (const f of fns) {
      if (f.addr == null) continue;
      const key = f.addr.toString();
      if (!byFunction.has(key)) byFunction.set(key, { addr: f.addr, files: [] });
      const e = byFunction.get(key);
      if (e.files.length < 40 && !e.files.includes(s.text)) e.files.push(s.text);
    }
  }
  if (!byFunction.size) return [];
  const targets = Array.from(byFunction.values()).map((e) => {
    const r = program.functionRange(e.addr);
    return Object.assign({}, e, { range: r, size: r ? Number(r.end - r.start) : 0 });
  }).filter((e) => e.range && e.size > 16 && e.size <= 64 * 1024).sort((a, b) => b.files.length - a.files.length).slice(0, limit);

  const out = [];
  for (let i = 0; i < targets.length; i++) {
    if (cancelled()) break;
    progress({ phase: 'schema', done: i, all: targets.length });
    const t = targets[i];
    let bytes = null;
    try { bytes = await read(t.range.start, t.size); } catch { bytes = null; }
    if (!bytes || bytes.length < 16) continue;
    const n = bytes.length >> 2, words = new Uint32Array(n), dv = new DataView(bytes.buffer, bytes.byteOffset, n * 4);
    for (let k = 0; k < n; k++) words[k] = dv.getUint32(k * 4, true);
    let schema = null;
    try { schema = decodeSchema(words, t.range.start); } catch { schema = null; }
    if (!schema) continue;
    out.push({ loader: t.addr, files: t.files, loaderSize: t.size, tables: schema.tables, best: schema.best });
  }
  progress({ phase: 'schema', done: targets.length, all: targets.length });
  out.sort((a, b) => (b.best.consistent === true) - (a.best.consistent === true) || (b.best.columns || 0) - (a.best.columns || 0));
  return out;
}

export function schemaForFile(schemas, filename) {
  for (const s of schemas || []) if ((s.files || []).includes(filename)) return s;
  return null;
}
function tableOf(x) { if (!x) return null; if (typeof x.offsetOf === 'function') return x; return x.best || null; }
export function columnToOffset(schema, column) { const t = tableOf(schema); return t ? t.offsetOf(column) : null; }
export function offsetToColumn(schema, offset) {
  const t = tableOf(schema);
  if (!t) return null;
  if (t.kind === 'unrolled') { const i = (t.offsets || []).indexOf(offset); return i < 0 ? null : i; }
  const stride = t.columnStride;
  if (!stride || offset % stride !== 0) return null;
  const i = offset / stride;
  if (t.columns != null && i >= t.columns) return null;
  return i;
}
