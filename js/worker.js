/*
 * Analysis worker: file I/O, Mach-O parsing, Capstone disassembly, search.
 * Runs off the main thread so scrolling and tapping never wait on it.
 *
 * Classic worker (not a module) because capstone.js is a UMD bundle that has
 * to come in through importScripts().
 */
'use strict';

importScripts('./macho.js', './words.js', '../capstone.js');

/* ── Constants ──────────────────────────────────────────────── */

const INSN_SIZE = 4;                 // ARM64 is fixed width — 1 row == 4 bytes
const CS_INSN_STRUCT = 240;          // sizeof(cs_insn) in this build
const OFF_ADDRESS = 8, OFF_SIZE = 16, OFF_MNEMONIC = 42, OFF_OP_STR = 74;

const CHUNK_ROWS = 1024;             // 4 KiB of code per chunk
const CHUNK_BYTES = CHUNK_ROWS * INSN_SIZE;
const BLOCK_BYTES = 256 * 1024;      // file read granularity
const BLOCK_CACHE = 16;              // ~4 MiB of raw file bytes
const SEARCH_BLOCK_HEX = 512 * 1024;
const SEARCH_BLOCK_ASM = 128 * 1024; // smaller: disassembly makes blocks slower
const SEARCH_LIMIT = 1000;
const HEADER_MAX = 4 * 1024 * 1024;  // cap on load-command area we will read

const SYMBOL_MAX = 400_000;          // シンボルはこれ以上読まない（メモリ保護）
const STRTAB_MAX = 48 * 1024 * 1024;
const STRINGS_LIMIT = 20_000;        // 文字列一覧の上限
const STRINGS_MIN = 4;               // これより短い文字列は拾わない
const XREF_LIMIT = 2000;
const SCAN_BLOCK = 1024 * 1024;      // 生スキャンの読み取り単位

/* プログラム全体の索引（呼び出し関係とデータ参照）の上限。
   ここを超えるファイルでは索引を打ち切り、その旨を伝える。黙って嘘をつかない。 */
const MAX_EDGES = 500_000;           // bl の辺
const MAX_REFS = 500_000;            // データへの参照
const MAX_KIND_WORDS = 16 * 1024 * 1024;  // 語ごとの分類を持つ上限（= 64 MiB のコード）

/* ── State ──────────────────────────────────────────────────── */

let file = null;
let fileSize = 0n;
let regions = new Map();
let slices = [];                      // 解析済みのスライス（アーキテクチャごと）
let cs = null;                        // { M, handle, hp }
let csError = null;
let searchToken = 0;

const blocks = new Map();             // blockIndex -> Uint8Array (insertion-ordered LRU)

/* ── Messaging ──────────────────────────────────────────────── */

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg || typeof msg.t !== 'string') return;
  if (msg.t === 'cancelSearch') { searchToken++; return; }
  try {
    const result = await handle(msg);
    if (msg.id != null) post({ t: 'ok', id: msg.id, result }, result && result.__transfer);
  } catch (err) {
    if (msg.id != null) post({ t: 'err', id: msg.id, error: errText(err) });
    else post({ t: 'fatal', error: errText(err) });
  }
};

function post(m, transfer) {
  if (transfer && transfer.length) {
    if (m.result) delete m.result.__transfer;
    self.postMessage(m, transfer);
  } else {
    if (m.result) delete m.result.__transfer;
    self.postMessage(m);
  }
}

function errText(err) {
  if (err == null) return 'Unknown error.';
  if (typeof err === 'string') return err;
  if (err.message) return String(err.message);
  return String(err);
}

async function handle(msg) {
  switch (msg.t) {
    case 'open':    return openFile(msg.file);
    case 'setRegions': return setRegions(msg.regions);
    case 'chunk':   return getChunk(msg);
    case 'search':  return runSearch(msg);
    case 'probe':   return probeCapstone();
    case 'analyze': return analyzeSlice(msg);
    case 'strings': return scanStrings(msg);
    case 'xrefs':   return findXrefs(msg);
    case 'readAt':  return readAtAddress(msg);
    case 'guessFunctions': return guessFunctions(msg);
    case 'scanProgram': return scanProgram(msg);
    case 'fieldAccess': return findFieldAccess(msg);
    default: throw new Error('Unknown request: ' + msg.t);
  }
}

/* ── Capstone ───────────────────────────────────────────────── */

let csPromise = null;

function initCapstone() {
  if (cs) return Promise.resolve(cs);
  if (csError) return Promise.reject(new Error(csError));
  if (csPromise) return csPromise;
  csPromise = (async () => {
    let M;
    try {
      M = await MCapstone({
        locateFile: (p) => new URL('../' + p, self.location.href).href,
        print: () => {}, printErr: () => {},
      });
    } catch (err) {
      csError = 'Could not start the disassembler engine (capstone.wasm failed to load). ' +
                'Make sure capstone.js and capstone.wasm are both deployed next to index.html.';
      throw new Error(csError);
    }
    const hp = M._malloc(4);
    const rc = M.ccall('cs_open', 'number', ['number', 'number', 'pointer'],
                       [M.ARCH_ARM64, M.MODE_ARM | M.MODE_LITTLE_ENDIAN, hp]);
    if (rc !== 0) {
      M._free(hp);
      csError = 'Capstone could not open an ARM64 handle (error ' + rc + ').';
      throw new Error(csError);
    }
    const handle = M.getValue(hp, 'i32');
    // SKIPDATA keeps a 1:1 row↔address mapping: undecodable words come back as
    // ".byte" entries of 4 bytes instead of ending the run.
    M.ccall('cs_option', 'number', ['number', 'number', 'number'], [handle, M.OPT_SKIPDATA, M.OPT_ON]);
    cs = { M, handle, hp, buf: 0, bufSize: 0, out: M._malloc(4) };
    return cs;
  })();
  csPromise.catch(() => { csPromise = null; });
  return csPromise;
}

async function probeCapstone() {
  await initCapstone();
  return { ok: true };
}

/**
 * Disassemble `u8` at `addr` (BigInt). Returns two parallel arrays — one entry
 * per 4-byte row, no per-instruction objects.
 */
function disasm(u8, addr) {
  const { M, handle } = cs;
  const rows = Math.ceil(u8.length / INSN_SIZE);
  const mn = new Array(rows).fill('');
  const ops = new Array(rows).fill('');

  const whole = Math.floor(u8.length / INSN_SIZE) * INSN_SIZE;
  if (whole > 0) {
    if (cs.bufSize < whole) {
      if (cs.buf) M._free(cs.buf);
      cs.buf = M._malloc(whole);
      cs.bufSize = whole;
    }
    M.writeArrayToMemory(u8.subarray(0, whole), cs.buf);

    let done = 0;
    let guard = 0;
    while (done < whole && guard++ < 64) {
      const count = M.ccall(
        'cs_disasm', 'number',
        ['number', 'number', 'number', 'number', 'number', 'number'],
        [handle, cs.buf + done, whole - done, addr + BigInt(done), 0, cs.out]);
      if (!count) break;
      const base = M.getValue(cs.out, 'i32');
      let consumed = 0;
      for (let i = 0; i < count; i++) {
        const p = base + i * CS_INSN_STRUCT;
        const size = M.getValue(p + OFF_SIZE, 'i16');
        const row = (done + consumed) / INSN_SIZE;
        if (Number.isInteger(row) && row < rows) {
          mn[row] = M.UTF8ToString(p + OFF_MNEMONIC);
          ops[row] = M.UTF8ToString(p + OFF_OP_STR);
        }
        consumed += size;
      }
      M.ccall('cs_free', 'void', ['number', 'number'], [base, count]);
      if (consumed <= 0) break;
      done += consumed;
      // Realign: ARM64 instructions are always 4-byte aligned.
      if (done % INSN_SIZE) done += INSN_SIZE - (done % INSN_SIZE);
    }
  }

  // Anything Capstone would not cover (tail bytes, engine hiccup) is shown as
  // raw data rather than silently dropped.
  for (let r = 0; r < rows; r++) {
    if (mn[r] === '') {
      const o = r * INSN_SIZE;
      const n = Math.min(INSN_SIZE, u8.length - o);
      let s = '';
      for (let i = 0; i < n; i++) s += (i ? ', ' : '') + '0x' + u8[o + i].toString(16).padStart(2, '0');
      mn[r] = '.byte';
      ops[r] = s;
    }
  }
  return { mn, ops };
}

/* ── File access ────────────────────────────────────────────── */

function num(v) { return typeof v === 'bigint' ? Number(v) : v; }

async function readRange(offset, length) {
  const start = num(offset);
  if (length <= 0) return new Uint8Array(0);
  const out = new Uint8Array(length);
  let written = 0;
  let bi = Math.floor(start / BLOCK_BYTES);
  while (written < length) {
    const block = await getBlock(bi);
    const blockStart = bi * BLOCK_BYTES;
    const from = Math.max(0, start + written - blockStart);
    if (from >= block.length) break;                       // past EOF
    const take = Math.min(block.length - from, length - written);
    out.set(block.subarray(from, from + take), written);
    written += take;
    bi++;
  }
  return written === length ? out : out.subarray(0, written);
}

async function getBlock(bi) {
  const hit = blocks.get(bi);
  if (hit) { blocks.delete(bi); blocks.set(bi, hit); return hit; }
  const start = bi * BLOCK_BYTES;
  if (start >= num(fileSize)) return new Uint8Array(0);
  const end = Math.min(start + BLOCK_BYTES, num(fileSize));
  const buf = await file.slice(start, end).arrayBuffer();
  const u8 = new Uint8Array(buf);
  blocks.set(bi, u8);
  while (blocks.size > BLOCK_CACHE) blocks.delete(blocks.keys().next().value);
  return u8;
}

/* ── open ───────────────────────────────────────────────────── */

async function openFile(f) {
  file = f;
  fileSize = BigInt(f.size);
  blocks.clear();
  regions = new Map();
  slices = [];

  if (f.size === 0) throw new Error('This file is empty (0 bytes).');

  const head = await readRange(0, Math.min(4096, f.size));
  const det = MachO.detect(head.buffer.slice(head.byteOffset, head.byteOffset + head.byteLength));

  const out = {
    name: f.name || 'binary',
    size: fileSize,
    format: 'Raw binary',
    slices: [],
    warnings: [],
  };

  if (det.kind === 'fat') {
    const fatHead = await readRange(0, Math.min(8 + 32 * 32, f.size));
    const arches = MachO.parseFat(fatHead.buffer.slice(fatHead.byteOffset, fatHead.byteOffset + fatHead.byteLength), fileSize);
    if (arches) {
      out.format = 'Mach-O universal (fat)';
      for (const a of arches) {
        try {
          out.slices.push(await readSlice(a.offset, a.size, a.name));
        } catch (err) {
          out.slices.push({ name: a.name, error: errText(err), offset: a.offset, size: a.size, regions: [] });
        }
      }
    } else {
      out.warnings.push('File begins with 0xCAFEBABE but is not a Mach-O universal binary.');
    }
  } else if (det.kind === 'macho') {
    out.format = det.is64 ? 'Mach-O 64-bit' : 'Mach-O 32-bit';
    try {
      out.slices.push(await readSlice(0n, fileSize, null));
    } catch (err) {
      // A damaged header should not cost the user the whole file: fall back to
      // the raw view and say why.
      out.format += ' (damaged header)';
      out.warnings.push('The Mach-O header could not be parsed (' + errText(err) +
                        ') — showing the file as raw bytes.');
    }
  }

  // A raw view of the whole file is always available as a fallback region.
  const raw = {
    id: 'raw',
    kind: 'file',
    name: 'Whole file (raw)',
    fileOffset: 0n,
    vmAddr: 0n,
    size: fileSize,
    declaredSize: fileSize,
    exec: det.kind === 'unknown',
    zerofill: false,
    truncated: false,
  };
  out.raw = raw;
  registerRegions([raw]);
  for (const s of out.slices) registerRegions(s.regions);
  slices = out.slices;

  return out;
}

async function readSlice(offset, size, label) {
  const head32 = await readRange(offset, 32);
  if (head32.length < 32) throw new Error('Slice is truncated.');
  const dv = new DataView(head32.buffer, head32.byteOffset, 32);
  const sizeofcmds = dv.getUint32(20, true);
  const total = Math.min(32 + sizeofcmds, HEADER_MAX, num(size));
  const hdr = await readRange(offset, total);
  const info = MachO.parseSlice(hdr.buffer.slice(hdr.byteOffset, hdr.byteOffset + hdr.byteLength), offset, size);
  const regs = MachO.regionsFrom(info, offset, size, fileSize);
  // Region ids must be unique across slices.
  const prefix = 's' + offset.toString(16) + '_';
  for (const r of regs) r.id = prefix + r.id;
  return {
    name: label || (info.cpu + (info.cpuSub && info.cpuSub !== 'all' ? ' (' + info.cpuSub + ')' : '')),
    offset, size, info, regions: regs,
  };
}

function registerRegions(list) {
  for (const r of list) regions.set(r.id, r);
}

function setRegions(list) {
  registerRegions(list);
  return { ok: true };
}

/* ── chunk ──────────────────────────────────────────────────── */

async function getChunk({ regionId, chunk, wantAsm }) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const start = region.fileOffset + BigInt(chunk) * BigInt(CHUNK_BYTES);
  const remaining = region.size - BigInt(chunk) * BigInt(CHUNK_BYTES);
  if (remaining <= 0n) return { regionId, chunk, bytes: new Uint8Array(0), mn: '', ops: '', rows: 0 };
  const len = Number(remaining < BigInt(CHUNK_BYTES) ? remaining : BigInt(CHUNK_BYTES));
  const bytes = await readRange(start, len);

  let mn = '', ops = '';
  if (wantAsm && bytes.length) {
    await initCapstone();
    const addr = region.vmAddr + BigInt(chunk) * BigInt(CHUNK_BYTES);
    const d = disasm(bytes, addr);
    mn = d.mn.join('\n'); ops = d.ops.join('\n');
  }
  const copy = new Uint8Array(bytes);   // detach a private copy; blocks stay cached
  return {
    regionId, chunk, bytes: copy, mn, ops,
    rows: Math.ceil(bytes.length / INSN_SIZE),
    __transfer: [copy.buffer],
  };
}

/* ── シンボルと関数の一覧 ───────────────────────────────────── */

/**
 * スライス 1 つぶんの「名前」を集める。
 *  - LC_SYMTAB    … 定義されている関数・変数の名前
 *  - 間接シンボル … __stubs / __got が指す外部関数の名前
 *  - LC_FUNCTION_STARTS … 関数の切れ目（名前がなくても分かる）
 *
 * 結果は転送可能な型付き配列で返す。数十万件あっても main 側でコピーが起きない。
 */
async function analyzeSlice({ sliceIndex }) {
  const slice = slices[sliceIndex];
  if (!slice || !slice.info) {
    return {
      addrs: new BigUint64Array(0), kinds: new Uint8Array(0), names: '',
      funcs: new BigUint64Array(0), symbolCount: 0, funcCount: 0, capped: false,
      __transfer: [],
    };
  }
  const info = slice.info;
  const base = slice.offset;
  let capped = false;
  let sym = null;

  if (info.symtab && info.symtab.nsyms > 0) {
    const entry = info.is64 ? 16 : 12;
    let nsyms = info.symtab.nsyms;
    if (nsyms > SYMBOL_MAX) { nsyms = SYMBOL_MAX; capped = true; }
    const symBuf = await readRange(base + BigInt(info.symtab.symoff), nsyms * entry);
    const strLen = Math.min(info.symtab.strsize, STRTAB_MAX);
    const strBuf = await readRange(base + BigInt(info.symtab.stroff), strLen);
    if (symBuf.length >= entry && strBuf.length) {
      try { sym = MachO.parseSymbols(symBuf, strBuf, info.is64); } catch { sym = null; }
    }
  }

  const entries = [];
  if (sym) {
    for (const d of MachO.definedSymbols(sym)) entries.push({ addr: d.addr, name: d.name, kind: 0 });
    if (info.dysymtab && info.dysymtab.nindirectsyms > 0) {
      const n = Math.min(info.dysymtab.nindirectsyms, SYMBOL_MAX);
      const ind = await readRange(base + BigInt(info.dysymtab.indirectsymoff), n * 4);
      if (ind.length >= 4) {
        try {
          for (const s of MachO.stubSymbols(info, ind, sym)) {
            entries.push({ addr: s.addr, name: s.name, kind: s.stub ? 1 : 2 });
          }
        } catch { /* 壊れていても他は返す */ }
      }
    }
  }

  // 同じアドレスに複数の名前が付くことがある。先に来たものを優先。
  entries.sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : a.kind - b.kind));
  const addrs = new BigUint64Array(entries.length);
  const kinds = new Uint8Array(entries.length);
  const names = new Array(entries.length);
  let n = 0;
  for (const e of entries) {
    if (n > 0 && addrs[n - 1] === e.addr) continue;
    addrs[n] = e.addr; kinds[n] = e.kind; names[n] = e.name;
    n++;
  }

  let funcs = new BigUint64Array(0);
  if (info.functionStarts && info.functionStarts.datasize > 0 && info.textVM != null) {
    const buf = await readRange(base + BigInt(info.functionStarts.dataoff),
                                Math.min(info.functionStarts.datasize, 8 * 1024 * 1024));
    try {
      const list = MachO.parseFunctionStarts(buf, info.textVM);
      funcs = new BigUint64Array(list.length);
      for (let i = 0; i < list.length; i++) funcs[i] = list[i];
    } catch { funcs = new BigUint64Array(0); }
  }

  const outAddrs = addrs.slice(0, n);
  const outKinds = kinds.slice(0, n);
  return {
    addrs: outAddrs,
    kinds: outKinds,
    names: names.slice(0, n).join('\n'),
    funcs,
    symbolCount: n,
    funcCount: funcs.length,
    capped,
    __transfer: [outAddrs.buffer, outKinds.buffer, funcs.buffer],
  };
}

/* ── 名前がないファイルで、関数の切れ目を推測する ───────────── */

/*
 * 命令語の読み取りは words.js に一本化してある。
 * 逆アセンブル結果の文字列ではなくビットそのものを見るので速く、
 * かつ node のテストから同じコードを検証できる。
 */
const looksLikePrologue = Words.looksLikePrologue;

/**
 * LC_FUNCTION_STARTS がないファイル（＝配布用にシンボルを削ったアプリ）向け。
 *
 *  1. bl の飛び先は、ほぼ確実に関数の先頭
 *  2. ret の直後で、プロローグらしい命令が来ていればそこも先頭
 *
 * 推測なので取りこぼしも誤検出もある。UI 側でその旨を伝えること。
 */
async function guessFunctions({ regionId, limit }) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const token = ++searchToken;
  const cap = Math.min(Number(limit) || 200_000, 200_000);
  const total = Number(region.size);
  const found = new Set();
  const lo = region.vmAddr, hi = region.vmAddr + region.size;

  let pos = 0;
  let prevWasEnd = false;
  while (pos < total) {
    if (token !== searchToken) return { starts: [], cancelled: true };
    const want = Math.min(SCAN_BLOCK, total - pos);
    const blk = await readRange(region.fileOffset + BigInt(pos), want);
    if (blk.length < 4) break;
    const words = Math.floor(blk.length / 4);
    const dv = new DataView(blk.buffer, blk.byteOffset, words * 4);
    for (let i = 0; i < words; i++) {
      const w = dv.getUint32(i * 4, true);
      const pc = region.vmAddr + BigInt(pos + i * 4);

      if (prevWasEnd && looksLikePrologue(w) && found.size < cap) found.add(pc);
      // ret / retaa / retab / 無条件 b は関数の終わりになりうる
      prevWasEnd = Words.looksLikeEnd(w);

      // bl の飛び先
      if (Words.isCallImm(w)) {
        const t = Words.branchImm26(w, pc);
        if (t != null && t >= lo && t < hi && found.size < cap) found.add(t);
      }
    }
    pos += words * 4;
    self.postMessage({ t: 'scanProgress', done: pos, all: total, hits: found.size });
    await yieldToQueue();
  }

  const list = Array.from(found).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const starts = new BigUint64Array(list.length);
  for (let i = 0; i < list.length; i++) starts[i] = list[i];
  return { starts, cancelled: false, __transfer: [starts.buffer] };
}

/* ── プログラム全体の索引（1 パスで作る） ───────────────────
 *
 * このツールの土台。セクションを 1 回だけ舐めて、
 *
 *   1. どの命令がどこを呼んでいるか（bl の辺）      → 呼び出しグラフ
 *   2. どの命令がどのアドレスを指しているか          → 文字列・データの参照元
 *   3. 語ごとの命令の種類                            → 関数ごとの統計（掛け算・store…）
 *
 * をまとめて取る。これがあると「文字列が近くにあるから関係ありそう」ではなく
 * 「この関数がこの文字列を参照し、この関数から呼ばれている」と言えるようになる。
 *
 * Capstone は通さない。逆アセンブルより桁違いに速いので、数十 MB でも一気に走る。
 */
async function scanProgram({ regionId }) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const token = ++searchToken;
  const total = Number(region.size);
  const words = Math.floor(total / 4);

  const callFrom = new BigUint64Array(Math.min(words, MAX_EDGES));
  const callTo = new BigUint64Array(callFrom.length);
  const refFrom = new BigUint64Array(Math.min(words, MAX_REFS));
  const refTo = new BigUint64Array(refFrom.length);
  const refKind = new Uint8Array(refFrom.length);      // 0 アドレス / 1 読み出し / 2 書き込み
  const kinds = new Uint8Array(Math.min(words, MAX_KIND_WORDS));

  let nCalls = 0, nRefs = 0;
  let callsCapped = false, refsCapped = false;
  const lo = region.vmAddr, hi = region.vmAddr + region.size;

  // レジスタごとに「直近の adrp が作ったページ」を覚える。ブロックをまたいでも続く。
  const pageOf = new Array(32).fill(null);
  const pageAt = new Array(32).fill(-1);
  let index = 0;
  let pos = 0;

  while (pos < total) {
    if (token !== searchToken) return { cancelled: true, __transfer: [] };
    const want = Math.min(SCAN_BLOCK, total - pos);
    const blk = await readRange(region.fileOffset + BigInt(pos), want);
    if (blk.length < 4) break;
    const n = Math.floor(blk.length / 4);
    const dv = new DataView(blk.buffer, blk.byteOffset, n * 4);

    for (let i = 0; i < n; i++, index++) {
      const w = dv.getUint32(i * 4, true);
      const pc = region.vmAddr + BigInt(pos + i * 4);
      const kind = Words.classifyWord(w);
      if (index < kinds.length) kinds[index] = kind;

      if (kind === Words.KIND.CALL) {
        const t = Words.branchImm26(w, pc);
        if (t != null) {
          if (nCalls < callFrom.length) { callFrom[nCalls] = pc; callTo[nCalls] = t; nCalls++; }
          else callsCapped = true;
        }
        continue;
      }

      // adrp / adr — アドレスの土台
      const rel = Words.pcRelTarget(w, pc);
      if (rel) {
        pageOf[rel.reg] = rel.value;
        pageAt[rel.reg] = index;
        if (!rel.page) addRef(pc, rel.value, 0);
        continue;
      }

      // adrp の続き: add で場所そのもの、ldr/str でその中身
      const pair = Words.pairedOffset(w);
      if (pair && pageOf[pair.rn] != null && index - pageAt[pair.rn] <= 8) {
        const full = pageOf[pair.rn] + pair.imm;
        addRef(pc, full, pair.load ? 1 : pair.store ? 2 : 0);
        // add の結果は別レジスタに移ることがあるので、そのまま引き継ぐ
        if (!pair.load && !pair.store) { pageOf[pair.rd] = full; pageAt[pair.rd] = index; }
        else if (pair.rd !== pair.rn) { pageOf[pair.rd] = null; pageAt[pair.rd] = -1; }
        continue;
      }

      // ldr literal — すぐ近くに置かれた定数
      if (kind === Words.KIND.LITERAL) {
        const t = Words.literalTarget(w, pc);
        if (t != null) addRef(pc, t, 1);
        continue;
      }

      // 書き換えられたレジスタのページ情報は捨てる（古い前提を持ち越さない）
      if (kind !== Words.KIND.NOP && kind !== Words.KIND.CONDBR && kind !== Words.KIND.CMP) {
        const d = w & 0x1f;
        if (pageAt[d] >= 0 && pageAt[d] !== index) { pageOf[d] = null; pageAt[d] = -1; }
      }
    }

    pos += n * 4;
    self.postMessage({ t: 'scanProgress', done: pos, all: total, hits: nCalls + nRefs });
    await yieldToQueue();
  }

  const outCallFrom = callFrom.slice(0, nCalls);
  const outCallTo = callTo.slice(0, nCalls);
  const outRefFrom = refFrom.slice(0, nRefs);
  const outRefTo = refTo.slice(0, nRefs);
  const outRefKind = refKind.slice(0, nRefs);
  return {
    regionId,
    vmAddr: region.vmAddr,
    words,
    callFrom: outCallFrom, callTo: outCallTo,
    refFrom: outRefFrom, refTo: outRefTo, refKind: outRefKind,
    kinds,
    kindsCovered: Math.min(words, kinds.length),
    callsCapped, refsCapped,
    cancelled: false,
    __transfer: [outCallFrom.buffer, outCallTo.buffer, outRefFrom.buffer,
      outRefTo.buffer, outRefKind.buffer, kinds.buffer],
  };

  function addRef(pc, target, k) {
    // セクションの外を指す参照も残す（文字列は別セクションにあるのが普通）。
    // ただしどう見てもアドレスでないものは捨てる。
    if (target == null || target <= 0n) return;
    void lo; void hi;
    if (nRefs < refFrom.length) {
      refFrom[nRefs] = pc; refTo[nRefs] = target; refKind[nRefs] = k; nRefs++;
    } else refsCapped = true;
  }
}

/* ── フィールドを触っている場所を探す ───────────────────────
 *
 * 「HP はどこで書き換えられているの？」に答えるための走査。
 *
 * Objective-C のクラス表から「HP は self の +0x20 にある 4 バイト」と分かったら、
 * あとは [xN, #0x20] の形でその大きさを読み書きしている命令を全部拾えばよい。
 * 文字列の参照と違って、これは**データそのものの居場所**を辿ることになる。
 *
 * ベースレジスタが本当に self かどうかまでは、ここでは判定しない
 * （それは呼び出し側が、その関数がどのクラスのメソッドかで絞る）。
 */
async function findFieldAccess({ regionId, offset, size, limit }) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const token = ++searchToken;
  const want = BigInt(offset);
  const wantSize = Number(size) || 0;
  const cap = Math.min(Number(limit) || 2000, 4000);
  const total = Number(region.size);
  const out = [];

  let pos = 0;
  while (pos < total && out.length < cap) {
    if (token !== searchToken) return { results: out, cancelled: true };
    const wantBytes = Math.min(SCAN_BLOCK, total - pos);
    const blk = await readRange(region.fileOffset + BigInt(pos), wantBytes);
    if (blk.length < 4) break;
    const words = Math.floor(blk.length / 4);
    const dv = new DataView(blk.buffer, blk.byteOffset, words * 4);
    for (let i = 0; i < words; i++) {
      const w = dv.getUint32(i * 4, true);
      const kind = Words.classifyWord(w);
      if (kind !== Words.KIND.LOAD && kind !== Words.KIND.STORE) continue;
      const mem = Words.memoryAccess(w);
      if (!mem || mem.disp == null || mem.indexed) continue;
      if (mem.disp !== want) continue;
      // 大きさが分かっているなら、それも合わせる（別の変数を拾わないため）
      if (wantSize > 0 && mem.size !== wantSize && !(wantSize > 8 && mem.size === 8)) continue;
      const byteOff = pos + i * 4;
      out.push({
        row: byteOff / 4,
        addr: region.vmAddr + BigInt(byteOff),
        kind: mem.load ? 'load' : 'store',
        base: mem.base,
        size: mem.size,
      });
      if (out.length >= cap) break;
    }
    pos += words * 4;
    self.postMessage({ t: 'scanProgress', done: pos, all: total, hits: out.length });
    await yieldToQueue();
  }
  return { results: out, cancelled: false, capped: out.length >= cap };
}

/* ── 文字列の抽出 ───────────────────────────────────────────── */

/** 読める ASCII が min 文字以上続くところを拾う。 */
async function scanStrings({ regionId, min, limit }) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const token = ++searchToken;
  const minLen = Math.max(2, Number(min) || STRINGS_MIN);
  const cap = Math.min(Number(limit) || STRINGS_LIMIT, STRINGS_LIMIT);
  const total = Number(region.size);
  const out = [];
  let pos = 0;
  let run = [];
  let runStart = 0;

  const flush = () => {
    if (run.length >= minLen) {
      out.push({
        addr: region.vmAddr + BigInt(runStart),
        offset: runStart,
        text: run.join(''),
      });
    }
    run = [];
  };

  while (pos < total && out.length < cap) {
    if (token !== searchToken) return { results: out, cancelled: true, capped: false };
    const want = Math.min(SCAN_BLOCK, total - pos);
    const blk = await readRange(region.fileOffset + BigInt(pos), want);
    if (!blk.length) break;
    for (let i = 0; i < blk.length; i++) {
      const c = blk[i];
      // タブと改行は文字列の一部として認める（メッセージによく入る）
      const printable = (c >= 0x20 && c < 0x7f) || c === 9 || c === 10;
      if (printable) {
        if (!run.length) runStart = pos + i;
        if (run.length < 400) run.push(c === 9 ? '\\t' : c === 10 ? '\\n' : String.fromCharCode(c));
        else if (run.length === 400) run.push('…');
      } else {
        flush();
        if (out.length >= cap) break;
      }
    }
    pos += blk.length;
    self.postMessage({ t: 'scanProgress', done: pos, all: total, hits: out.length });
    await yieldToQueue();
  }
  flush();
  return { results: out.slice(0, cap), cancelled: false, capped: out.length >= cap };
}

/* ── 相互参照（どこからここを見ているか） ───────────────────── */

/*
 * capstone を通さず、4 バイトの語を直接読んで分岐先とアドレス生成を拾う。
 * 逆アセンブルより桁違いに速いので、数十 MB のセクションでも一気に走査できる。
 */
const wordTarget = Words.wordTarget;
const pcRelTarget = Words.pcRelTarget;
const pairedOffset = Words.pairedOffset;

/**
 * `target` を指している命令を region の中から探す。
 * 直接の分岐に加えて、adrp + add / adrp + ldr の 2 行組も解決する
 * （文字列やデータを「誰が使っているか」を追うにはこれが要る）。
 */
async function findXrefs({ regionId, target, limit }) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const token = ++searchToken;
  const want = BigInt(target);
  const cap = Math.min(Number(limit) || XREF_LIMIT, XREF_LIMIT);
  const total = Number(region.size);
  const out = [];

  // レジスタごとに「直近の ADRP が作ったページ」を覚えておく。
  const pageOf = new Array(32).fill(null);
  const pageAt = new Array(32).fill(-1);
  let index = 0;

  let pos = 0;
  while (pos < total && out.length < cap) {
    if (token !== searchToken) return { results: out, cancelled: true, capped: false };
    const wantBytes = Math.min(SCAN_BLOCK, total - pos);
    const blk = await readRange(region.fileOffset + BigInt(pos), wantBytes);
    if (blk.length < 4) break;
    const words = Math.floor(blk.length / 4);
    const dv = new DataView(blk.buffer, blk.byteOffset, words * 4);
    for (let i = 0; i < words; i++, index++) {
      const w = dv.getUint32(i * 4, true);
      const byteOff = pos + i * 4;
      const pc = region.vmAddr + BigInt(byteOff);

      const direct = wordTarget(w, pc);
      if (direct !== null && direct === want) {
        out.push({ row: byteOff / 4, addr: pc, kind: 'branch' });
        if (out.length >= cap) break;
        continue;
      }
      const rel = pcRelTarget(w, pc);
      if (rel) {
        pageOf[rel.reg] = rel.value;
        pageAt[rel.reg] = index;
        if (!rel.page && rel.value === want) {
          out.push({ row: byteOff / 4, addr: pc, kind: 'address' });
          if (out.length >= cap) break;
        }
        continue;
      }
      const pair = pairedOffset(w);
      if (pair && pageOf[pair.rn] != null && index - pageAt[pair.rn] <= 8) {
        const full = pageOf[pair.rn] + pair.imm;
        if (full === want) {
          out.push({
            row: byteOff / 4, addr: pc,
            kind: pair.load ? 'load' : pair.store ? 'store' : 'address',
          });
          if (out.length >= cap) break;
        }
        // ADD の結果は別レジスタに移ることがあるので、そのまま引き継ぐ
        if (!pair.load && !pair.store) { pageOf[pair.rd] = full; pageAt[pair.rd] = index; }
      }
    }
    pos += words * 4;
    self.postMessage({ t: 'scanProgress', done: pos, all: total, hits: out.length });
    await yieldToQueue();
  }
  return { results: out, cancelled: false, capped: out.length >= cap };
}

/* ── 任意のアドレスを読む ───────────────────────────────────── */

/** 仮想アドレス → ファイル内の位置。見つからなければ null。 */
function vmToFile(addr) {
  for (const r of regions.values()) {
    if (r.id === 'raw' || r.zerofill) continue;
    if (addr >= r.vmAddr && addr < r.vmAddr + r.size) {
      return { offset: r.fileOffset + (addr - r.vmAddr), region: r };
    }
  }
  return null;
}

/**
 * アドレスの中身を読む。text: true なら 0 で終わる文字列として解釈する。
 * 「adrp + add で作ったアドレスに何があるか」を見せるために使う。
 */
async function readAtAddress({ addr, len, text }) {
  const at = BigInt(addr);
  const hit = vmToFile(at);
  if (!hit) return { found: false };
  const max = Math.min(Number(len) || 256, 1 << 20);   // ページ単位でまとめて読むことがある
  const avail = Number(hit.region.vmAddr + hit.region.size - at);
  const bytes = await readRange(hit.offset, Math.min(max, avail));
  const result = {
    found: true,
    region: hit.region.name,
    fileOffset: hit.offset,
    bytes: new Uint8Array(bytes),
  };
  if (text) {
    let s = '';
    let terminated = false;
    for (let i = 0; i < bytes.length; i++) {
      const c = bytes[i];
      if (c === 0) { terminated = true; break; }
      if (c === 9) s += '\\t';
      else if (c === 10) s += '\\n';
      else if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c);
      else { s = ''; break; }                     // 読めない → 文字列ではない
    }
    result.text = s;
    result.terminated = terminated;
  }
  result.__transfer = [result.bytes.buffer];
  return result;
}

/* ── search ─────────────────────────────────────────────────── */

async function runSearch({ regionId, kind, query, hex, from }) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const token = ++searchToken;
  const results = [];
  const total = Number(region.size);
  const startByte = Math.max(0, Math.min(total, Number(from || 0)));
  let scanned = 0;
  let capped = false;

  if (kind === 'hex') {
    const pat = hex;
    if (!pat || !pat.bytes.length) throw new Error('Enter a hex pattern such as “FD 7B” or “D1??00”.');
    const plen = pat.bytes.length;
    let pos = startByte;
    let carry = new Uint8Array(0);
    while (pos < total) {
      if (token !== searchToken) return { cancelled: true, results, scanned };
      const want = Math.min(SEARCH_BLOCK_HEX, total - pos);
      const blk = await readRange(region.fileOffset + BigInt(pos), want);
      if (!blk.length) break;
      const joined = carry.length ? concat(carry, blk) : blk;
      const base = pos - carry.length;
      const limit = joined.length - plen + 1;
      for (let i = 0; i < limit; i++) {
        let ok = true;
        for (let j = 0; j < plen; j++) {
          if ((joined[i + j] & pat.mask[j]) !== pat.bytes[j]) { ok = false; break; }
        }
        if (ok) {
          const byteOff = base + i;
          push(results, byteOff, region, joined, i, plen);
          if (results.length >= SEARCH_LIMIT) { capped = true; break; }
        }
      }
      pos += blk.length;
      scanned = pos - startByte;
      if (capped) break;
      carry = plen > 1 ? joined.subarray(joined.length - Math.min(plen - 1, joined.length)) : new Uint8Array(0);
      progress(scanned, total - startByte, results.length);
      await yieldToQueue();
    }
  } else if (kind === 'text') {
    // ASCII の文字列として探す。大文字小文字は区別しない。
    const needle = String(query || '');
    if (!needle) throw new Error('Enter text to search for.');
    const pat = new Uint8Array(needle.length);
    for (let i = 0; i < needle.length; i++) pat[i] = needle.charCodeAt(i) & 0xff;
    const lower = (b) => (b >= 65 && b <= 90 ? b + 32 : b);
    for (let i = 0; i < pat.length; i++) pat[i] = lower(pat[i]);
    const plen = pat.length;
    let pos = startByte;
    let carry = new Uint8Array(0);
    while (pos < total) {
      if (token !== searchToken) return { cancelled: true, results, scanned };
      const want = Math.min(SEARCH_BLOCK_HEX, total - pos);
      const blk = await readRange(region.fileOffset + BigInt(pos), want);
      if (!blk.length) break;
      const joined = carry.length ? concat(carry, blk) : blk;
      const base = pos - carry.length;
      const limit = joined.length - plen + 1;
      for (let i = 0; i < limit; i++) {
        let ok = true;
        for (let j = 0; j < plen; j++) {
          if (lower(joined[i + j]) !== pat[j]) { ok = false; break; }
        }
        if (!ok) continue;
        const byteOff = base + i;
        // 前後を少し添えて、どんな文字列の中の一致か分かるようにする
        let text = '';
        const from = Math.max(0, i - 16), to = Math.min(joined.length, i + plen + 24);
        for (let k = from; k < to; k++) {
          const ch = joined[k];
          text += (ch >= 0x20 && ch < 0x7f) ? String.fromCharCode(ch) : '·';
        }
        results.push({ row: Math.floor(byteOff / INSN_SIZE), addr: region.vmAddr + BigInt(byteOff), text, byteOff });
        if (results.length >= SEARCH_LIMIT) { capped = true; break; }
      }
      pos += blk.length;
      scanned = pos - startByte;
      if (capped) break;
      carry = plen > 1 ? joined.subarray(joined.length - Math.min(plen - 1, joined.length)) : new Uint8Array(0);
      progress(scanned, total - startByte, results.length);
      await yieldToQueue();
    }
  } else {
    await initCapstone();
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) throw new Error('Enter text to search for.');
    let pos = Math.floor(startByte / INSN_SIZE) * INSN_SIZE;
    while (pos < total) {
      if (token !== searchToken) return { cancelled: true, results, scanned };
      const want = Math.min(SEARCH_BLOCK_ASM, total - pos);
      const blk = await readRange(region.fileOffset + BigInt(pos), want);
      if (!blk.length) break;
      const addr = region.vmAddr + BigInt(pos);
      const d = disasm(blk, addr);
      const mns = d.mn, opss = d.ops;
      for (let i = 0; i < mns.length; i++) {
        const text = opss[i] ? mns[i] + ' ' + opss[i] : mns[i];
        if (text.toLowerCase().indexOf(needle) >= 0) {
          const byteOff = pos + i * INSN_SIZE;
          results.push({
            row: byteOff / INSN_SIZE,
            addr: region.vmAddr + BigInt(byteOff),
            text,
          });
          if (results.length >= SEARCH_LIMIT) { capped = true; break; }
        }
      }
      pos += blk.length;
      scanned = pos - startByte;
      if (capped) break;
      progress(scanned, total - startByte, results.length);
      await yieldToQueue();
    }
  }
  return { results, scanned, capped, cancelled: false };

  function progress(done, all, hits) {
    self.postMessage({ t: 'searchProgress', done, all, hits });
  }
}

function push(results, byteOff, region, buf, i, plen) {
  const row = Math.floor(byteOff / INSN_SIZE);
  let text = '';
  for (let k = 0; k < Math.min(plen, 8); k++) {
    text += (k ? ' ' : '') + buf[i + k].toString(16).toUpperCase().padStart(2, '0');
  }
  if (plen > 8) text += ' …';
  // `addr` is the exact match address; `row` is the (4-byte aligned) row to scroll to.
  results.push({ row, addr: region.vmAddr + BigInt(byteOff), text, byteOff });
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}

/* Lets queued messages (e.g. cancelSearch) run between blocks. */
function yieldToQueue() {
  return new Promise((r) => setTimeout(r, 0));
}
