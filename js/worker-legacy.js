/*
 * Analysis worker: file I/O, Mach-O parsing, Capstone disassembly, search.
 * Runs off the main thread so scrolling and tapping never wait on it.
 *
 * Classic worker (not a module) because capstone.js is a UMD bundle that has
 * to come in through importScripts().
 */
'use strict';

importScripts('./macho.js', './words.js', './worker-budget.js', './objc-stub-recovery.js', './address-provenance.js', '../capstone.js');
const WORKER_BUDGET = globalThis.HexWorkerBudget;

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
/* 文字列一覧の上限。20000 で切っていたころは、The Battle Cats の
   メソッド名 37161 本のうち 17161 本が黙って消えていた（＝機能の 46%）。
   1 本あたり数十バイトなので、この数でも数十 MB には届かない。 */
const STRINGS_LIMIT = 500_000;
const STRINGS_MIN = 4;               // これより短い文字列は拾わない
const XREF_LIMIT = 2000;
const SCAN_BLOCK = 1024 * 1024;      // 生スキャンの読み取り単位

/* プログラム全体の索引（呼び出し関係とデータ参照）の上限。
   ここを超えるファイルでは索引を打ち切り、その旨を伝える。黙って嘘をつかない。

   最初から上限ぶんを確保すると 28 MB のアプリでも 100 MB 以上を占めるので、
   小さく取って足りなくなったら倍にする。上限は「これ以上は現実的でない」線。
   実測: The Battle Cats（18 MB のコード）で bl 695k / データ参照 422k。
   ここを 500k で切っていたころは、呼び出し関係の 28% が黙って消えていた。 */
const MAX_EDGES = 8_000_000;         // bl の辺
const MAX_REFS = 8_000_000;          // データへの参照
const EDGES_INITIAL = 262_144;       // 最初に確保する数（足りなければ倍々に伸ばす）
const MAX_KIND_WORDS = 16 * 1024 * 1024;  // 語ごとの分類を持つ上限（= 64 MiB のコード）
const PROGRAM_INDEX_BUDGET_BYTES = WORKER_BUDGET.PROGRAM_INDEX_BYTES;
const FUNCTION_CANDIDATE_BUDGET = WORKER_BUDGET.FUNCTION_AUX_SLOTS;

/* ── State ──────────────────────────────────────────────────── */

let file = null;
let fileSize = 0n;
let regions = new Map();
let slices = [];                      // 解析済みのスライス（アーキテクチャごと）
let cs = null;                        // { M, handle, hp }
let csError = null;
let currentEpoch = 0;
let openChain = Promise.resolve();
const activeRequests = new Map();             // request id -> epoch
const cancelledRequests = new Set();

const blocks = new Map();             // blockIndex -> Uint8Array (insertion-ordered LRU)

/* ── Messaging ──────────────────────────────────────────────── */

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg || typeof msg.t !== 'string') return;
  if (msg.t === 'cancel' || msg.t === 'cancelSearch') {
    for (const [id, epoch] of activeRequests) {
      if ((msg.requestId == null || msg.requestId === id) &&
          (msg.epoch == null || msg.epoch === epoch)) cancelledRequests.add(id);
    }
    return;
  }
  const run = async () => {
    if (msg.t === 'open') currentEpoch = msg.epoch;
    if (msg.epoch !== currentEpoch) throw new Error('Stale analysis request.');
    if (msg.id != null) activeRequests.set(msg.id, msg.epoch);
    return handle(msg);
  };
  try {
    /* File opens mutate all worker state, so serialize them. A later epoch always wins. */
    const task = msg.t === 'open' ? (openChain = openChain.then(run, run)) : run();
    const result = await task;
    if (msg.id != null) post({ t: 'ok', id: msg.id, epoch: msg.epoch, result }, result && result.__transfer);
  } catch (err) {
    if (msg.id != null) post({ t: 'err', id: msg.id, epoch: msg.epoch, error: errText(err) });
    else post({ t: 'fatal', error: errText(err) });
  } finally {
    if (msg.id != null) {
      activeRequests.delete(msg.id);
      cancelledRequests.delete(msg.id);
    }
  }
};

function cancelled(requestId) { return requestId != null && cancelledRequests.has(requestId); }
function scanProgress(requestId, epoch, done, all, hits) {
  self.postMessage({ t: 'scanProgress', requestId, epoch, done, all, hits });
}

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
    case 'valueShapes': return scanValueShapes(msg);
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
  const previous = { file, fileSize, regions, slices, blocks: new Map(blocks) };
  try {
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
  } catch (error) {
    file = previous.file;
    fileSize = previous.fileSize;
    regions = previous.regions;
    slices = previous.slices;
    blocks.clear();
    for (const [key, value] of previous.blocks) blocks.set(key, value);
    throw error;
  }
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
async function analyzeSlice({ sliceIndex, id: requestId }) {
  const slice = slices[sliceIndex];
  if (!slice || !slice.info) {
    return {
      addrs: new BigUint64Array(0), kinds: new Uint8Array(0), names: [],
      funcs: new BigUint64Array(0), symbolCount: 0, funcCount: 0, capped: false,
      allSeedsExact: false, discoveryComplete: false, functionStartsExact: false,
      functionDiscovery: { complete:false, capped:false, reasons:['no-authoritative-function-starts'] },
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
    for (const d of MachO.definedSymbols(sym)) entries.push({ addr: d.addr, name: d.name, kind: 0, ext: d.ext });
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

  /*
   * Xcode 14 以降のアプリでは、メソッド呼び出しが専用の中継地点にまとめられている。
   * そこは間接シンボル表に載らないので、上の処理だけでは名前が 1 つも付かない。
   * バイナリを読んで自分で名前を作る（詳しくは objcStubNames）。
   */
  try {
    for (const s of await objcStubNames(slice, entries, requestId)) {
      entries.push({ addr: s.addr, name: s.name, kind: 1 });
    }
  } catch { /* 読めなければ名前を足さないだけ */ }

  // 同じアドレスに複数の名前が付くことがある。先に来たものを優先。
  entries.sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : a.kind - b.kind));
  const addrs = new BigUint64Array(entries.length);
  const kinds = new Uint8Array(entries.length);
  const flags = new Uint8Array(entries.length);     // 1 = 外へ公開されている名前
  const names = new Array(entries.length);
  let n = 0;
  for (const e of entries) {
    if (n > 0 && addrs[n - 1] === e.addr) continue;
    addrs[n] = e.addr; kinds[n] = e.kind; names[n] = e.name;
    flags[n] = e.ext ? 1 : 0;
    n++;
  }

  let funcs = new BigUint64Array(0);
  let functionStartsExact = false;
  // Exact decoded starts (plus the Mach-O entry seed) are also the hard
  // control-flow roots for ADR/ADRP provenance in the worker scans.
  slice.functionStarts = [];
  if (info.functionStarts && info.functionStarts.datasize > 0 && info.textVM != null) {
    const buf = await readRange(base + BigInt(info.functionStarts.dataoff),
                                Math.min(info.functionStarts.datasize, 8 * 1024 * 1024));
    try {
      const list = MachO.parseFunctionStarts(buf, info.textVM, { regions:slice.regions || [], architecture:info.architecture || 'arm64' });
      const seeds = list.slice();
      if (info.entry != null && !seeds.some((value) => value === info.entry)) seeds.push(info.entry);
      seeds.sort((a,b)=>(a<b?-1:a>b?1:0));
      slice.functionStarts = seeds;
      funcs = new BigUint64Array(seeds.length);
      for (let i = 0; i < seeds.length; i++) funcs[i] = seeds[i];
      functionStartsExact = list.length > 0 && list.complete === true;
    } catch { slice.functionStarts = []; funcs = new BigUint64Array(0); }
  }

  if ((!info.functionStarts || !info.functionStarts.datasize) && info.entry != null) {
    slice.functionStarts = [info.entry];
    funcs = new BigUint64Array([info.entry]);
    functionStartsExact = false;
  }

  /* Known noreturn imports make the instruction after a call a strong boundary
     signal. Cache their stub addresses on the slice so guessFunctions can use
     them without rebuilding symbol tables during the code scan. */
  const NORETURN_NAME = /(?:^|_)(?:stack_chk_fail|objc_exception_throw|abort|assert_rtn|cxa_throw|terminate|swift_.*(?:fatal|trap)|fatalError)(?:$|@)/i;
  slice.noreturnTargets = new Set();
  for (const e of entries) {
    if (e && e.addr != null && NORETURN_NAME.test(e.name || '')) slice.noreturnTargets.add(e.addr);
  }

  const outAddrs = addrs.slice(0, n);
  const outKinds = kinds.slice(0, n);
  const outFlags = flags.slice(0, n);
  return {
    addrs: outAddrs,
    kinds: outKinds,
    flags: outFlags,
    names: names.slice(0, n).map((name) => String(name ?? '')),
    funcs,
    symbolCount: n,
    funcCount: funcs.length,
    allSeedsExact: funcs.length > 0,
    discoveryComplete: functionStartsExact,
    functionStartsExact,
    functionDiscovery: { complete:functionStartsExact, capped:false,
      reasons:functionStartsExact ? [] : ['no-complete-lc-function-starts'] },
    capped,
    __transfer: [outAddrs.buffer, outKinds.buffer, outFlags.buffer, funcs.buffer],
  };
}

/* ── メソッド呼び出しの中継地点（__objc_stubs）に名前を付ける ──
 *
 * Xcode 14 より前は、メソッド呼び出しがこう書かれていた:
 *
 *     adrp x1, selref@PAGE      ← メソッド名の在り処
 *     ldr  x1, [x1, ...]
 *     bl   _objc_msgSend
 *
 * 呼び出す側にメソッド名が書いてあるので、その場で「何を呼ぶか」が読めた。
 * ところが今のコンパイラは、同じ並びを **セレクタごとの中継地点** にまとめる:
 *
 *     bl 0x10116d440            ← 呼び出し側にはもう何も書いていない
 *
 *     0x10116d440: adrp x1, selref@PAGE / ldr x1, [x1,…] / adrp x16, _objc_msgSend@GOT
 *                  ldr x16, [x16,…] / br x16
 *
 * この中継地点は間接シンボル表にも LC_SYMTAB にも載らない。つまり何もしないと、
 * アプリの中の Objective-C 呼び出しが **一件残らず「行き先不明」になる**。
 * 実測では 16414 か所。要約も役割推定も、ここが空白のままでは当たらない。
 *
 * そこで中継地点そのものを読んで、selref → メソッド名を復元し、
 *
 *     _objc_msgSend$initWithFrame:
 *
 * という名前を付ける（Xcode が生成する名前と同じ綴りにしてある）。
 * 読めなかった中継地点には、何も付けない。
 */

const MAX_OBJC_STUBS = 80_000;
const OBJC_STUB_MAX_BYTES = 8 * 1024 * 1024;

async function objcStubNames(slice, known, requestId = null) {
  return globalThis.HexObjCStubRecovery.recover({
    slice, known, readRange, cancelled, requestId, fileSize, Words,
    budget:WORKER_BUDGET.createSupplementalBudget(), sanitizePointer:sanitizeStubPointer,
    maxSelector:MAX_SELECTOR, maxStubs:MAX_OBJC_STUBS, maxSectionBytes:OBJC_STUB_MAX_BYTES,
  });
}

const MAX_SELECTOR = 512;

/**
 * chained fixups で書かれたポインタをほどく。objc.js の sanitizePointer と同じ考え方
 * （あちらは ES モジュールなので worker からは読めない。判定は 1 か所にまとめられない）。
 */
function sanitizeStubPointer(v, base) {
  if (v == null || v === 0n) return null;
  // Some chained-fixup slots contain only the image-relative low target.
  // With a known image base, values below it are offsets, not VM addresses.
  if (base != null && v < BigInt(base)) return BigInt(base) + v;
  if (v < 0x0001000000000000n) return v;
  const low = v & 0x0000000fffffffffn;
  if (low === 0n) return null;
  if (v & 0x8000000000000000n) return null;      // 外部から入る値。メソッド名ではない
  if (base != null && low < base) return base + low;
  return low;
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
 *  0. __unwind_info に載っている行（事実。当てずっぽうが混ざらない）
 *  1. クラス表に載っているメソッドの実装アドレス（同じく事実）
 *  2. bl の飛び先は、ほぼ確実に関数の先頭
 *  3. ret の直後で、プロローグらしい命令が来ていればそこも先頭
 *
 * 0 と 1 は表を読んだだけなので確実。2 と 3 は推測で、取りこぼしも誤検出もある。
 * 命令の並びだけから当てていたころは適合率 73.6% / 再現率 64.8% だった。
 * 表を先に読むだけで、どちらも大きく上がる。
 */
async function guessFunctions({ regionId, limit, requestId, epoch }) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const cap = Math.min(Number(limit) || 400_000, 400_000);
  const total = Number(region.size);
  const found = new Set();
  const lo = region.vmAddr, hi = region.vmAddr + region.size;
  const auxLimit = Math.min(FUNCTION_CANDIDATE_BUDGET, WORKER_BUDGET.functionAuxLimit(cap));
  let auxSlots = 0;
  let candidateBudgetHit = false;
  const reserveAux = (count = 1) => {
    if (candidateBudgetHit || auxSlots + count > auxLimit) { candidateBudgetHit = true; return false; }
    auxSlots += count; return true;
  };
  const addAux = (set, value) => {
    if (set.has(value)) return true;
    if (!reserveAux()) return false;
    set.add(value); return true;
  };

  const slice = slices.find((s) => (s.regions || []).some((r) => r.id === regionId));
  const imageBase = slice && slice.info ? slice.info.textVM : null;
  const unwind = slice ? (slice.regions || []).find((r) => r.section === '__unwind_info' && r.size > 0n) : null;
  if (unwind && imageBase != null && unwind.size < BigInt(16 * 1024 * 1024)) {
    try {
      const buf = await readRange(unwind.fileOffset, Number(unwind.size));
      for (const a of MachO.parseUnwindStarts(buf, imageBase)) {
        if (a >= lo && a < hi && found.size < cap) found.add(a);
      }
    } catch { /* 読めなければ推測だけで進む */ }
  }

  /*
   * C++ の仮想関数表。__const / __data に、コードを指すポインタが並んでいる。
   * Cocos2d-x や Unreal のようなアプリでは、メソッドの大半がここにしか現れない
   * （どこからも bl されず、表ごしに呼ばれるため）。読むだけで数万件増える。
   */
  /*
   * Metadata/vtable pointers are useful evidence, but not proof by themselves.
   * In Swift state machines and large switch dispatchers, tables also point at
   * internal labels.  Keep them separate until instruction-level evidence has
   * had a chance to confirm them.
   */
  const dataCandidates = new Set();
  if (slice && imageBase != null) {
    for (const r of slice.regions || []) {
      if (r.size <= 0n || r.size > BigInt(32 * 1024 * 1024)) continue;
      if (!/^__(const|data|objc_const|cfstring)$/.test(r.section || '')) continue;
      try {
        const buf = await readRange(r.fileOffset, Number(r.size));
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        for (let p = 0; p + 8 <= buf.byteLength; p += 8) {
          const t = sanitizeStubPointer(dv.getBigUint64(p, true), imageBase);
          if (t == null || t < lo || t >= hi || (t & 3n)) continue;
          if (dataCandidates.size < cap) addAux(dataCandidates, t);
        }
      } catch { /* 読めない区画は飛ばす */ }
      if (cancelled(requestId)) return { starts: [], cancelled: true };
    }
  }

  let pos = 0;
  let prevWasEnd = false;
  let prevWasRet = false;
  let prevKind = null;
  let prevWord = null;
  let prevPc = null;
  let prevWasNoreturnCall = false;

  /*
   * Tiny leaf/accessor/thunk functions often have no stack prologue at all.
   * Keep a three-instruction window after a terminal instruction and classify
   * it only after the full scan, when intra-function branch targets are known.
   * This is deliberately evidence-based: every accepted pattern below was
   * measured against an independent oracle, and branch-target blocks are
   * excluded before they can become fake functions.
   */
  const postRet = [];
  const postBranch = [];
  const postTrap = [];
  const postNoreturn = [];
  const pendingWindows = [];
  const conditionalTargets = new Set();
  const directBranchTargets = new Set();
  /* Data-table targets immediately after an indirect `br xN` are a classic
     switch/state-machine shape.  They are only suppressed when the file has a
     large cohort of them; isolated cases remain untouched. */
  const indirectFallthroughData = new Set();
  const noreturnTargets = slice && slice.noreturnTargets ? slice.noreturnTargets : new Set();
  const POST_RET_START_KINDS = new Set([
    Words.KIND.LOAD, Words.KIND.ADRP, Words.KIND.RET, Words.KIND.LOGIC,
    Words.KIND.FCONV, Words.KIND.FARITH, Words.KIND.SIMD,
  ]);
  const beginWindow = (arr, pc, w, kind) => {
    if (!reserveAux(2)) return;
    const c = { addr: pc, word: w, kind, nextWord: null, nextKind: null, thirdWord: null, thirdKind: null };
    arr.push(c); pendingWindows.push(c);
  };

  while (pos < total) {
    if (cancelled(requestId)) return { starts: [], cancelled: true };
    const want = Math.min(SCAN_BLOCK, total - pos);
    const blk = await readRange(region.fileOffset + BigInt(pos), want);
    if (blk.length < 4) break;
    const words = Math.floor(blk.length / 4);
    const dv = new DataView(blk.buffer, blk.byteOffset, words * 4);
    for (let i = 0; i < words; i++) {
      const w = dv.getUint32(i * 4, true);
      const pc = region.vmAddr + BigInt(pos + i * 4);
      const currentKind = Words.classifyWord(w);

      if (dataCandidates.has(pc) && prevWord != null && Words.isBr(prevWord) &&
          !looksLikePrologue(w) && !Words.isBranchImm(w) && !Words.isRet(w)) {
        addAux(indirectFallthroughData, pc);
      }

      /* Fill the 2nd/3rd instruction of recently opened tiny-function windows. */
      for (let q = pendingWindows.length - 1; q >= 0; q--) {
        const c = pendingWindows[q];
        const d = pc - c.addr;
        if (d === 4n) { c.nextWord = w; c.nextKind = currentKind; }
        else if (d === 8n) { c.thirdWord = w; c.thirdKind = currentKind; pendingWindows.splice(q, 1); }
        else if (d > 8n) pendingWindows.splice(q, 1);
      }

      if (prevWasEnd && looksLikePrologue(w) && found.size < cap) found.add(pc);
      if (prevWasRet) beginWindow(postRet, pc, w, currentKind);
      else if (prevKind === Words.KIND.BRANCH && prevWord != null && Words.isBranchImm(prevWord)) {
        beginWindow(postBranch, pc, w, currentKind);
      } else if (prevKind === Words.KIND.TRAP) {
        beginWindow(postTrap, pc, w, currentKind);
      }
      if (prevWasNoreturnCall && looksLikePrologue(w)) {
        if (reserveAux()) postNoreturn.push(pc);
      }

      if (Words.isCondBranch(w)) {
        const t = Words.condBranchTarget(w, pc);
        if (t != null && t >= lo && t < hi) addAux(conditionalTargets, t);
      }

      if (Words.isBranchImm(w)) {
        const t = Words.branchImm26(w, pc);
        if (t != null && t >= lo && t < hi) addAux(directBranchTargets, t);
      }

      // bl の飛び先
      let callTarget = null;
      if (Words.isCallImm(w)) {
        callTarget = Words.branchImm26(w, pc);
        if (callTarget != null && callTarget >= lo && callTarget < hi && found.size < cap) found.add(callTarget);
      }

      prevWasRet = Words.isRet(w);
      prevWasEnd = Words.looksLikeEnd(w);
      prevWasNoreturnCall = callTarget != null && noreturnTargets.has(callTarget);
      prevKind = currentKind;
      prevWord = w;
      prevPc = pc;
    }
    pos += words * 4;
    scanProgress(requestId, epoch, pos, total, found.size);
    await yieldToQueue();
  }

  const isBlocked = (c) => conditionalTargets.has(c.addr) || directBranchTargets.has(c.addr);
  const rdOf = (w) => w == null ? -1 : (w & 0x1f);
  const rnOf = (w) => w == null ? -1 : ((w >>> 5) & 0x1f);
  const branchToKnown = (w, pc) => {
    if (w == null || !Words.isBranchImm(w)) return false;
    const t = Words.branchImm26(w, pc);
    return t != null && (found.has(t) || dataCandidates.has(t));
  };

  const POST_RET_START_PAIRS = new Set([
    Words.KIND.MOVREG + ':' + Words.KIND.ARITH,
    Words.KIND.MOVREG + ':' + Words.KIND.ADRP,
    Words.KIND.MOVIMM + ':' + Words.KIND.BRANCH,
    Words.KIND.BRANCH + ':' + Words.KIND.STORE,
    Words.KIND.MOVIMM + ':' + Words.KIND.RET,
    Words.KIND.STORE + ':' + Words.KIND.STORE,
    Words.KIND.ARITH + ':' + Words.KIND.CMP,
    Words.KIND.MOVREG + ':' + Words.KIND.MOVIMM,
  ]);
  for (const c of postRet) {
    if (found.size >= cap) break;
    if (isBlocked(c)) continue;
    const strongFirst = POST_RET_START_KINDS.has(c.kind);
    const strongPair = c.nextKind != null && POST_RET_START_PAIRS.has(c.kind + ':' + c.nextKind);
    const mem = c.kind === Words.KIND.STORE ? Words.memoryAccess(c.word) : null;
    const objcSetterLeaf = c.nextKind === Words.KIND.RET && mem && mem.store &&
      !mem.pair && mem.base === 0 && mem.reg === 2;

    /* Additional measured tiny-leaf signatures. */
    const tinySetterChain = c.kind === Words.KIND.STORE && c.nextKind === Words.KIND.RET &&
      new Set([Words.KIND.LOAD, Words.KIND.ARITH, Words.KIND.MOVREG, Words.KIND.MOVIMM]).has(c.thirdKind);
    const arithConst = c.kind === Words.KIND.ARITH && c.nextKind === Words.KIND.MOVIMM;
    const movStoreLoad = c.kind === Words.KIND.MOVREG && c.nextKind === Words.KIND.STORE && c.thirdKind === Words.KIND.LOAD;
    const constConstTail = c.kind === Words.KIND.MOVIMM && c.nextKind === Words.KIND.MOVIMM &&
      c.thirdKind === Words.KIND.BRANCH;
    const condLeaf = c.kind === Words.KIND.CONDBR &&
      new Set([Words.KIND.ARITH, Words.KIND.STORE, Words.KIND.LOAD, Words.KIND.CONDBR]).has(c.nextKind);
    const cmpSelectRet = c.kind === Words.KIND.CMP && c.nextKind === Words.KIND.CSEL && c.thirdKind === Words.KIND.RET;
    const constStoreRet = c.kind === Words.KIND.MOVIMM && c.nextKind === Words.KIND.STORE && c.thirdKind === Words.KIND.RET;
    const trapBody = c.kind === Words.KIND.TRAP && c.nextKind === Words.KIND.TRAP && c.thirdKind === Words.KIND.TRAP;
    const storeConstStore = c.kind === Words.KIND.STORE && c.nextKind === Words.KIND.MOVIMM && c.thirdKind === Words.KIND.STORE;
    const cmpCondAdrp = c.kind === Words.KIND.CMP && c.nextKind === Words.KIND.CONDBR && c.thirdKind === Words.KIND.ADRP;

    if (!strongFirst && !strongPair && !objcSetterLeaf && !tinySetterChain && !arithConst &&
        !movStoreLoad && !constConstTail && !condLeaf && !cmpSelectRet && !constStoreRet && !trapBody &&
        !storeConstStore && !cmpCondAdrp) continue;
    found.add(c.addr);
  }

  /* A trap/padding boundary is a very strong separator. */
  for (const c of postTrap) {
    if (found.size >= cap) break;
    if (isBlocked(c)) continue;
    if (c.kind === Words.KIND.ADRP || c.kind === Words.KIND.ARITH || c.kind === Words.KIND.STORE) found.add(c.addr);
  }

  /*
   * Boundaries after an unconditional tail branch. These patterns cover the
   * tiny getters, global-address wrappers and forwarding thunks generated by
   * Clang/Swift without turning ordinary branch targets into functions.
   */
  const ADRP_SAFE_THIRD = new Set([
    Words.KIND.BRANCH, Words.KIND.RET, Words.KIND.LOAD,
    Words.KIND.ADRP, Words.KIND.ARITH, Words.KIND.CMP,
  ]);
  for (const c of postBranch) {
    if (found.size >= cap) break;
    if (isBlocked(c)) continue;
    let strong = false;
    const mem = (c.kind === Words.KIND.LOAD || c.kind === Words.KIND.STORE) ? Words.memoryAccess(c.word) : null;

    // ldr x0/w0, [x0,...] — canonical tiny getter / object forwarding leaf.
    if (c.kind === Words.KIND.LOAD && mem && mem.load && mem.base === 0 && mem.reg === 0) strong = true;
    if (c.kind === Words.KIND.RET) strong = true;
    if (c.kind === Words.KIND.MOVIMM && c.nextKind === Words.KIND.RET) strong = true;
    if (c.kind === Words.KIND.ADRP && c.nextKind === Words.KIND.ADRP) strong = true;

    if (c.kind === Words.KIND.ADRP && c.nextKind === Words.KIND.LOAD && ADRP_SAFE_THIRD.has(c.thirdKind)) strong = true;
    if (c.kind === Words.KIND.ADRP && c.nextKind === Words.KIND.STORE) {
      const m2 = Words.memoryAccess(c.nextWord);
      if (m2 && m2.base === rdOf(c.word)) strong = true;
    }
    if (c.kind === Words.KIND.ADRP && c.nextKind === Words.KIND.ARITH &&
        rdOf(c.nextWord) === rdOf(c.word) && rnOf(c.nextWord) === rdOf(c.word)) {
      const d = rdOf(c.word);
      const m3 = (c.thirdKind === Words.KIND.LOAD || c.thirdKind === Words.KIND.STORE)
        ? Words.memoryAccess(c.thirdWord) : null;
      if ((c.thirdKind === Words.KIND.LOAD && m3 && m3.base === d) ||
          c.thirdKind === Words.KIND.MOVIMM ||
          (c.thirdKind === Words.KIND.BRANCH && branchToKnown(c.thirdWord, c.addr + 8n))) strong = true;
    }
    if (c.kind === Words.KIND.ARITH &&
        ((rdOf(c.word) === 0 && rnOf(c.word) === 0) || c.nextKind === Words.KIND.CMP)) strong = true;
    /* Complete tiny leaves / wrapper prefixes that remain unambiguous even
       without a conventional prologue. */
    if (c.kind === Words.KIND.MOVREG && c.nextKind === Words.KIND.MOVREG && c.thirdKind === Words.KIND.ADRP) strong = true;
    if (c.kind === Words.KIND.LOAD && c.nextKind === Words.KIND.LOGIC && c.thirdKind === Words.KIND.RET) strong = true;
    if (c.kind === Words.KIND.LOAD && c.nextKind === Words.KIND.CMP && c.thirdKind === Words.KIND.CSEL) strong = true;
    if (c.kind === Words.KIND.CONDBR && c.nextKind === Words.KIND.STORE && c.thirdKind === Words.KIND.STORE) strong = true;

    /* Remaining zero-false-positive signatures measured after the broad rules.
       These are only accepted after an unconditional terminal branch and only
       when the address is not itself a branch target, so ordinary CFG blocks
       cannot satisfy them. */
    if (c.kind === Words.KIND.MOVIMM && c.nextKind === Words.KIND.BRANCH &&
        new Set([Words.KIND.STORE, Words.KIND.MOVREG]).has(c.thirdKind)) strong = true;
    if (c.kind === Words.KIND.LOAD && c.nextKind === Words.KIND.BRANCH && c.thirdKind === Words.KIND.ARITH) strong = true;
    if (c.kind === Words.KIND.ARITH && c.nextKind === Words.KIND.LOAD && c.thirdKind === Words.KIND.CMP) strong = true;
    if (c.kind === Words.KIND.MOVREG && c.nextKind === Words.KIND.LOAD && c.thirdKind === Words.KIND.ADRP) strong = true;

    if (c.kind === Words.KIND.LOAD && c.nextKind === Words.KIND.BRANCH && branchToKnown(c.nextWord, c.addr + 4n)) strong = true;
    if (c.kind === Words.KIND.LOAD && c.nextKind === Words.KIND.LOAD && c.thirdKind === Words.KIND.BRANCH &&
        branchToKnown(c.thirdWord, c.addr + 8n)) strong = true;
    if (c.kind === Words.KIND.LOAD && c.nextKind === Words.KIND.MOVREG && c.thirdKind === Words.KIND.BRANCH &&
        branchToKnown(c.thirdWord, c.addr + 8n)) strong = true;
    if (c.kind === Words.KIND.MOVREG && c.nextKind === Words.KIND.BRANCH && branchToKnown(c.nextWord, c.addr + 4n)) strong = true;
    if (c.kind === Words.KIND.ARITH && c.nextKind === Words.KIND.BRANCH && branchToKnown(c.nextWord, c.addr + 4n)) strong = true;

    /* ABI forwarding wrappers often materialize two explicit arguments and
       immediately tail-call. Requiring two constants keeps this at measured
       zero false positives on the corpus, unlike accepting every MOVIMM→B. */
    if (c.kind === Words.KIND.MOVIMM && c.nextKind === Words.KIND.MOVIMM && c.thirdKind === Words.KIND.BRANCH) {
      const d0 = rdOf(c.word), d1 = rdOf(c.nextWord);
      if ((d0 >= 2 && d0 <= 7) || (d1 >= 2 && d1 <= 7)) strong = true;
    }
    if (strong) found.add(c.addr);
  }

  /* noreturn calls (abort/assert/throw/stack_chk_fail) terminate the caller.
     A textbook prologue immediately after them is therefore a new function,
     unless control flow explicitly targets that address. */
  for (const a of postNoreturn) {
    if (found.size >= cap) break;
    if (!conditionalTargets.has(a) && !directBranchTargets.has(a)) found.add(a);
  }

  /* One-instruction tail thunks often form runs directly before a known start.
     Walk backwards to a fixed point so A: b X / B: b Y / C: real-body is
     recovered as three functions, while excluding any address used as an
     intra-function branch target. */
  let changed = true;
  while (changed && found.size < cap) {
    changed = false;
    for (const c of postBranch) {
      if (c.kind !== Words.KIND.BRANCH || isBlocked(c) || found.has(c.addr)) continue;
      if (!found.has(c.addr + 4n) && !dataCandidates.has(c.addr + 4n)) continue;
      found.add(c.addr); changed = true;
      if (found.size >= cap) break;
    }
  }

  /*
   * Add metadata-derived candidates after all stronger evidence has run.
   * If a binary contains a dense cohort of pointers to fallthrough labels after
   * indirect branches, those are switch/state-machine entries rather than
   * independent functions.  Crucially, a candidate confirmed by unwind data,
   * BL targets, prologues, or the tiny-function rules is already in `found` and
   * is never removed.  The cohort gate avoids changing ordinary vtables.
   */
  const suppressIndirectFallthrough = dataCandidates.size >= 1000 &&
    indirectFallthroughData.size >= 1000 &&
    (indirectFallthroughData.size / dataCandidates.size) >= 0.02;
  for (const a of dataCandidates) {
    if (found.size >= cap) break;
    if (suppressIndirectFallthrough && indirectFallthroughData.has(a) && !found.has(a)) continue;
    found.add(a);
  }

  const list = Array.from(found).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const starts = new BigUint64Array(list.length);
  for (let i = 0; i < list.length; i++) starts[i] = list[i];
  const startCapHit = found.size >= cap;
  const capped = startCapHit || candidateBudgetHit;
  const truncationReason = candidateBudgetHit ? 'candidate-memory-budget' : startCapHit ? 'function-start-cap-reached' : null;
  return {
    starts, cancelled: false, capped, truncated: capped, complete: !capped, cap, truncationReason,
    completeness: {
      complete: !capped,
      reason: truncationReason,
      discovered: list.length,
      cap,
      addressRange: { regionId, vmAddr: region.vmAddr, size: region.size, complete: !capped },
    },
    __transfer: [starts.buffer],
  };
}

function functionStartsForRegion(region) {
  if (!region) return [];
  for (const slice of slices || []) {
    if (!slice || !slice.functionStarts || !slice.functionStarts.length) continue;
    if ((slice.regions || []).some((r) => r && r.id === region.id)) return slice.functionStarts;
  }
  return [];
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
async function scanProgram({ regionId, requestId, epoch, callLimit, refLimit, kindLimit }) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const total = Number(region.size);
  const words = Math.floor(total / 4);
  const capOf=(value,hard)=>value==null?hard:Math.max(0,Math.min(hard,Math.floor(Number(value)||0)));
  const callCap=capOf(callLimit,MAX_EDGES), refCap=capOf(refLimit,MAX_REFS), kindCap=capOf(kindLimit,MAX_KIND_WORDS);

  const callInitial = Math.min(words, EDGES_INITIAL, callCap);
  const refInitial = Math.min(words, EDGES_INITIAL, refCap);
  let callFrom = new BigUint64Array(callInitial);
  let callTo = new BigUint64Array(callInitial);
  let refFrom = new BigUint64Array(refInitial);
  let refTo = new BigUint64Array(refInitial);
  let refKind = new Uint8Array(refInitial);
  const kinds = new Uint8Array(Math.min(words, kindCap));

  let nCalls = 0, nRefs = 0;
  let callsCapped = false, refsCapped = false;
  let memoryCapped = false;
  const lo = region.vmAddr, hi = region.vmAddr + region.size;
  const provenance = AddressProvenance.create({
    words: Words,
    pairWindow: PAIR_WINDOW,
    functionStarts: functionStartsForRegion(region),
    rangeStart: region.vmAddr,
    rangeEnd: region.vmAddr + region.size,
  });
  let index = 0;
  let pos = 0;

  const allocatedBytes = () => callFrom.byteLength + callTo.byteLength + refFrom.byteLength + refTo.byteLength + refKind.byteLength + kinds.byteLength;
  const canGrow = (temporaryBytes) => WORKER_BUDGET.withinProgramBudget(allocatedBytes(), temporaryBytes) && allocatedBytes() + temporaryBytes <= PROGRAM_INDEX_BUDGET_BYTES;

  while (pos < total) {
    if (cancelled(requestId)) return { cancelled: true, __transfer: [] };
    const want = Math.min(SCAN_BLOCK, total - pos);
    const blk = await readRange(region.fileOffset + BigInt(pos), want);
    if (blk.length < 4) break;
    const n = Math.floor(blk.length / 4);
    const dv = new DataView(blk.buffer, blk.byteOffset, n * 4);

    for (let i = 0; i < n; i++, index++) {
      const w = dv.getUint32(i * 4, true);
      const pc = region.vmAddr + BigInt(pos + i * 4);
      provenance.enter(pc);
      const kind = Words.classifyWord(w);
      if (index < kinds.length) kinds[index] = kind;

      if (kind === Words.KIND.CALL || kind === Words.KIND.INDCALL) {
        if (kind === Words.KIND.CALL) {
          const t = Words.branchImm26(w, pc);
          if (t != null && !callsCapped) {
            if (nCalls === callFrom.length && !growCalls()) callsCapped = memoryCapped = true;
            if (nCalls < callFrom.length) { callFrom[nCalls] = pc; callTo[nCalls] = t; nCalls++; }
          }
        }
        provenance.control(w, pc, kind);
        continue;
      }
      if (kind === Words.KIND.CONDBR || kind === Words.KIND.BRANCH ||
          kind === Words.KIND.RET || kind === Words.KIND.TRAP) {
        provenance.control(w, pc, kind);
        continue;
      }

      const rel = Words.pcRelTarget(w, pc);
      if (rel) {
        provenance.note(rel.reg, rel.value, index);
        if (!rel.page) addRef(pc, rel.value, 0);
        continue;
      }

      const pair = Words.pairedOffset(w);
      const base = pair ? provenance.base(pair.rn, index) : null;
      if (pair && base != null) {
        const full = base + pair.imm;
        addRef(pc, full, pair.load ? 1 : pair.store ? 2 : 0);
        if (!pair.load && !pair.store) provenance.note(pair.rd, full, index);
        else if (pair.load && pair.gpDest !== false) provenance.kill(pair.rd);
        continue;
      }

      if (kind === Words.KIND.LITERAL) {
        const t = Words.literalTarget(w, pc);
        if (t != null) addRef(pc, t, 1);
        provenance.kill(w & 0x1f);
        continue;
      }

      const memWrite = Words.memoryAccess(w);
      if (memWrite) {
        // FP/SIMD register numbers share the low encoding bits with xN/wN, but
        // writing d8/q8 must not destroy an address held in x8.  Conversely,
        // integer pair loads can overwrite both GP destinations, and pre/post
        // indexed memory operations overwrite their base register.
        if (memWrite.load && !memWrite.vector) {
          provenance.kill(memWrite.reg);
          if (memWrite.pair && memWrite.reg2 != null) provenance.kill(memWrite.reg2);
        }
        if (memWrite.mode === 'pre' || memWrite.mode === 'post') provenance.kill(memWrite.base);
        continue;
      }
      if (kind === Words.KIND.FARITH || kind === Words.KIND.FMUL || kind === Words.KIND.SIMD ||
          (kind === Words.KIND.CSEL && Words.isFpCondSelect?.(w))) continue;
      if (WRITES_LOW_REG[kind]) provenance.kill(w & 0x1f);
    }

    pos += n * 4;
    scanProgress(requestId, epoch, pos, total, nCalls + nRefs);
    await yieldToQueue();
  }

  const truncationReasons = [];
  if (callsCapped) truncationReasons.push('call-edge-memory-budget');
  if (refsCapped) truncationReasons.push('reference-memory-budget');
  if (kinds.length < words) truncationReasons.push('kind-stat-budget');
  const outCallFrom=callFrom.slice(0,nCalls), outCallTo=callTo.slice(0,nCalls);
  const outRefFrom=refFrom.slice(0,nRefs), outRefTo=refTo.slice(0,nRefs), outRefKind=refKind.slice(0,nRefs);
  const outKinds=kinds.slice(0,Math.min(words,kinds.length));
  return {
    regionId,
    vmAddr: region.vmAddr,
    words,
    callFrom:outCallFrom, callTo:outCallTo, callCount: nCalls,
    refFrom:outRefFrom, refTo:outRefTo, refKind:outRefKind, refCount: nRefs,
    kinds:outKinds,
    kindsCovered: Math.min(words, outKinds.length),
    callsCapped, refsCapped,
    cancelled: false,
    complete: truncationReasons.length === 0,
    truncated: truncationReasons.length > 0,
    truncationReason: truncationReasons[0] || null,
    completeness: { complete: truncationReasons.length === 0, reasons: truncationReasons, memoryBudgetBytes: PROGRAM_INDEX_BUDGET_BYTES, allocatedBytes: allocatedBytes() },
    __transfer: [outCallFrom.buffer, outCallTo.buffer, outRefFrom.buffer, outRefTo.buffer, outRefKind.buffer, outKinds.buffer],
  };

  function addRef(pc, target, k) {
    if (target == null || target <= 0n || refsCapped) return;
    void lo; void hi;
    if (nRefs === refFrom.length && !growRefs()) refsCapped = memoryCapped = true;
    if (nRefs < refFrom.length) {
      refFrom[nRefs] = pc; refTo[nRefs] = target; refKind[nRefs] = k; nRefs++;
    }
  }

  function growCalls() {
    const size = Math.min(Math.max(1, callFrom.length * 2), MAX_EDGES, callCap);
    if (size <= callFrom.length || !canGrow(size * 16)) return false;
    callFrom = grow64(callFrom, size);
    callTo = grow64(callTo, size);
    return true;
  }
  function growRefs() {
    const size = Math.min(Math.max(1, refFrom.length * 2), MAX_REFS, refCap);
    if (size <= refFrom.length || !canGrow(size * 17)) return false;
    refFrom = grow64(refFrom, size);
    refTo = grow64(refTo, size);
    const k = new Uint8Array(size);
    k.set(refKind);
    refKind = k;
    return true;
  }
}

function grow64(arr, size) {
  const out = new BigUint64Array(size);
  out.set(arr);
  return out;
}

/*
 * その命令が「下位 5 ビットのレジスタを書き換えるか」。
 *
 * 書き換えないものまで捨てると、adrp で組んだアドレスの追跡が途切れる（scanProgram 参照）。
 * 逆に書き換えるものを残すと、まったく別のアドレスをでっち上げる。どちらも実害があるので、
 * 迷うもの（分類できなかった OTHER）は「書き換えた」側に倒しておく。
 */
const WRITES_LOW_REG = (() => {
  const K = Words.KIND;
  const t = new Uint8Array(64).fill(1);
  for (const k of [K.NOP, K.CONDBR, K.CMP, K.BRANCH, K.CALL, K.INDCALL, K.RET,
    K.STORE, K.SYS, K.TRAP]) t[k] = 0;
  return t;
})();

/*
 * adrp と、その続きの add / ldr が、何命令まで離れていてよいか。
 *
 * コンパイラはこの 2 つを隣り合わせに出すのが普通だが、最適化で間に別の計算が
 * 何十命令も挟まることがある。8 命令で切っていたときは、データ参照の 4 割強を
 * 取りこぼしていた。長くしすぎると別の値を組み合わせてしまうので、
 * 実測（The Battle Cats）で適合率が落ちない上限を採る。
 */
const PAIR_WINDOW = Number.MAX_SAFE_INTEGER;


/* ── 値の「ふるまい」を全文走査で集める ─────────────────────
 *
 * ここが、名前も文字列も残っていないアプリのための入口。
 *
 * ゲーム本体が C++（Cocos2d-x / Unity）で書かれていると、Objective-C のクラス表には
 * 広告 SDK しか載らない。文字列も、文言がぜんぶ外部ファイルにあると 1 つも残らない。
 * 実際 The Battle Cats には「attack」も「攻撃」もバイナリ中に 1 文字も無い。
 * 名前で探すやり方は、ここで完全に行き止まりになる。
 *
 * それでも **ふるまいは残っている**。ゲームの数値には決まった形がある:
 *
 *     体力  … 別の値のぶんだけ減り、0 で止められ、また増える
 *     攻撃力 … 自分は変わらず、他のオブジェクトの体力を減らす「引く量」になる
 *     所持金 … 同じオブジェクトの中で、片方が増えて片方が減る
 *
 * この形は名前と違って消せない。消したら動かなくなるので。
 * だからここでは、命令の並びからその形だけを取り出す。
 *
 *     ldr w8, [x19, #0x2c]     ← 読む
 *     sub w8, w8, w9           ← 別の値のぶんだけ引く
 *     bic w8, w8, w8, asr #31  ← 0 未満にならないよう止める
 *     str w8, [x19, #0x2c]     ← 書き戻す
 *
 * これを 1 件の「出来事」として記録する。引く量 w9 がどこから来たかも一緒に。
 * Capstone は通さず、命令語のビットを直接読む（18 MB でも数秒で終わる）。
 */

/* 出来事の印（evFlags のビット） */
const SHAPE_DECREASE = 1;    // 減った
const SHAPE_INCREASE = 2;    // 増えた
const SHAPE_CLAMP    = 4;    // 0 で止めていた
const SHAPE_CROSS    = 8;    // 引く量が「別のオブジェクト」から来ている
const SHAPE_SCALED   = 16;   // 引く量が掛け算・割り算を通っている（倍率つき）

/* 引く量の出どころ（evAmtKind） */
const AMT_NONE = 0, AMT_FIELD = 1, AMT_IMM = 2, AMT_CALL = 3;

const MAX_SHAPE_EVENTS = 200_000;

async function scanValueShapes({ regionId, requestId, epoch }) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const total = Number(region.size);

  const evAddr = new BigUint64Array(MAX_SHAPE_EVENTS);
  const evDisp = new Int32Array(MAX_SHAPE_EVENTS);
  const evAmtDisp = new Int32Array(MAX_SHAPE_EVENTS);
  const evSize = new Uint8Array(MAX_SHAPE_EVENTS);
  const evFlags = new Uint8Array(MAX_SHAPE_EVENTS);
  const evAmtKind = new Uint8Array(MAX_SHAPE_EVENTS);
  const evSpan = new Int32Array(MAX_SHAPE_EVENTS);
  /*
   * 「引く量」の側の大きさと、その入れ物の大きさ。
   * 攻撃力はこちら側にしか現れないので、ここを持たないと
   * 攻撃力を容器の頭と取り違える（自分では 1 度も増減しないため）。
   */
  const evAmtSize = new Uint8Array(MAX_SHAPE_EVENTS);
  const evAmtSpan = new Int32Array(MAX_SHAPE_EVENTS);
  let n = 0;
  let capped = false;

  /*
   * そのオブジェクトが、どれくらい大きいものとして使われているか。
   *
   * これが要るのは、C++ のアプリでは +0x0 / +0x8 / +0x10 の増減が
   * 何千件も出てくるため。中身はほぼ std::vector の要素数や参照カウンタで、
   * ゲームの数値ではない。ところが「減って増えて 0 で止まる」形は同じなので、
   * ふるまいだけでは選り分けられない。
   *
   * 見分けがつくのは **入れ物の大きさ**。同じレジスタが +0x9f4 のような
   * 遠い場所にも使われているなら、それは何十個も値を持つゲームの構造体で、
   * 0x0〜0x18 しか触られないものは容器の頭でしかない。
   */
  const spanOf = new Int32Array(32);
  const noteSpan = (base, disp) => {
    if (base < 0 || base > 31) return;
    if (disp > spanOf[base]) spanOf[base] = disp;
  };

  /*
   * レジスタ 1 本ぶんの「今もっている値の由来」。
   *   base/disp … どのオブジェクトのどの位置から読んだか
   *   dir       … そこから増えたか減ったか
   *   amt*      … 増減の量がどこから来たか
   */
  const pBase = new Int8Array(32).fill(-1);      // -1 = 由来が分からない
  const pDisp = new Int32Array(32);
  const pSize = new Uint8Array(32);
  const pDir = new Int8Array(32);                // 0 なし / 1 増 / -1 減
  const pClamp = new Uint8Array(32);
  const pAmtKind = new Uint8Array(32);
  const pAmtBase = new Int8Array(32);
  const pAmtDisp = new Int32Array(32);
  const pAmtScaled = new Uint8Array(32);
  const pAmtSize = new Uint8Array(32);
  const pAmtSpan = new Int32Array(32);

  const forget = (r) => {
    if (r < 0 || r >= 31) return;
    pBase[r] = -1;
    // 別のものを入れたのだから、それまでの「入れ物の大きさ」も引き継がない
    spanOf[r] = 0;
  };
  const forgetAll = () => { pBase.fill(-1); };
  const copy = (d, s) => {
    if (d === 31) return;
    if (d !== s) spanOf[d] = spanOf[s];
    pBase[d] = pBase[s]; pDisp[d] = pDisp[s]; pSize[d] = pSize[s];
    pDir[d] = pDir[s]; pClamp[d] = pClamp[s];
    pAmtKind[d] = pAmtKind[s]; pAmtBase[d] = pAmtBase[s];
    pAmtDisp[d] = pAmtDisp[s]; pAmtScaled[d] = pAmtScaled[s];
    pAmtSize[d] = pAmtSize[s]; pAmtSpan[d] = pAmtSpan[s];
  };
  /* 量をまだ持っていないときだけ書き込む（最初に見つけた出どころを採る）。 */
  const setAmount = (d, kind, base, disp, scaled, size, span) => {
    if (pAmtKind[d] !== AMT_NONE) return;
    pAmtKind[d] = kind; pAmtBase[d] = base == null ? -1 : base;
    pAmtDisp[d] = disp || 0; pAmtScaled[d] = scaled ? 1 : 0;
    pAmtSize[d] = size || 0; pAmtSpan[d] = span || 0;
  };

  let pos = 0;
  while (pos < total) {
    if (cancelled(requestId)) return { cancelled: true, __transfer: [] };
    const want = Math.min(SCAN_BLOCK, total - pos);
    const blk = await readRange(region.fileOffset + BigInt(pos), want);
    if (blk.length < 4) break;
    const words = Math.floor(blk.length / 4);
    const dv = new DataView(blk.buffer, blk.byteOffset, words * 4);

    for (let i = 0; i < words && n < MAX_SHAPE_EVENTS; i++) {
      const w = dv.getUint32(i * 4, true);

      /*
       * 呼び出しをまたいでも、x19〜x28 は呼ばれた側が元に戻す決まりになっている
       * （AAPCS64）。オブジェクトへのポインタはたいていそこに置かれるので、
       * ここを捨てずに残せるかどうかで、追える連鎖の長さがまるで変わる。
       */
      if (Words.isCallImm(w) || Words.isIndirectCall(w)) {
        for (let r = 0; r <= 18; r++) { pBase[r] = -1; spanOf[r] = 0; }
        pBase[0] = -1;
        // 戻り値は「呼んだ先で決まった量」。ダメージ計算はたいていこの形。
        pAmtKind[0] = AMT_NONE;
        copy(0, 0);
        pBase[0] = -1; pAmtKind[0] = AMT_CALL; pAmtBase[0] = -1; pAmtDisp[0] = 0;
        continue;
      }
      // 無条件分岐・復帰は前提が続かない。条件分岐は値が生きているので残す。
      if (Words.isBranchImm(w) || Words.isRet(w) || Words.isBr(w)) {
        forgetAll(); spanOf.fill(0); continue;
      }
      if (Words.isCondBranch(w)) continue;

      const mem = Words.memoryAccess(w);
      if (mem && !mem.pair && !mem.indexed && mem.disp != null) {
        const d = Number(mem.disp);
        noteSpan(mem.base, d);
        if (mem.load) {
          const r = mem.reg;
          if (r !== 31) {
            spanOf[r] = 0;                     // 読み込んだ先は「別のもの」になる
            pBase[r] = mem.base; pDisp[r] = d; pSize[r] = mem.size;
            pDir[r] = 0; pClamp[r] = 0;
            pAmtKind[r] = AMT_NONE; pAmtBase[r] = -1; pAmtDisp[r] = 0; pAmtScaled[r] = 0;
            pAmtSize[r] = 0; pAmtSpan[r] = 0;
          }
          continue;
        }
        // 書き戻し — 同じ場所へ戻っているなら、それが「値が変わった瞬間」
        const s = mem.reg;
        if (s < 31 && pBase[s] >= 0 && pDir[s] !== 0 &&
            pBase[s] === mem.base && pDisp[s] === d) {
          let flags = pDir[s] > 0 ? SHAPE_INCREASE : SHAPE_DECREASE;
          if (pClamp[s]) flags |= SHAPE_CLAMP;
          if (pAmtScaled[s]) flags |= SHAPE_SCALED;
          if (pAmtKind[s] === AMT_FIELD && pAmtBase[s] >= 0 && pAmtBase[s] !== mem.base) {
            flags |= SHAPE_CROSS;
          }
          evAddr[n] = region.vmAddr + BigInt(pos + i * 4);
          evDisp[n] = d;
          evSize[n] = mem.size;
          evFlags[n] = flags;
          evAmtKind[n] = pAmtKind[s];
          evAmtDisp[n] = pAmtKind[s] === AMT_FIELD ? pAmtDisp[s] : 0;
          evSpan[n] = spanOf[mem.base];
          evAmtSize[n] = pAmtSize[s];
          evAmtSpan[n] = pAmtSpan[s];
          n++;
          if (n >= MAX_SHAPE_EVENTS) capped = true;
        }
        continue;
      }

      /* add / sub（レジスタどうし、シフト無し） */
      if (Words.masked(w, 0x1f200000) === 0x0b000000 && ((w >>> 10) & 0x3f) === 0) {
        const d = w & 31, a = (w >>> 5) & 31, m = (w >>> 16) & 31;
        const sub = ((w >>> 30) & 1) === 1;
        if (((w >>> 29) & 1) === 1 && d === 31) continue;      // cmp
        if (pBase[a] >= 0) {
          const amtKind = pBase[m] >= 0 ? AMT_FIELD : AMT_NONE;
          const amtBase = pBase[m] >= 0 ? pBase[m] : -1;
          const amtDisp = pBase[m] >= 0 ? pDisp[m] : 0;
          const scaled = pAmtScaled[m];
          copy(d, a);
          pDir[d] = sub ? -1 : 1;
          if (amtKind !== AMT_NONE) {
            setAmount(d, AMT_FIELD, amtBase, amtDisp, scaled, pSize[m], spanOf[amtBase]);
          }
          else if (pAmtKind[m] === AMT_CALL) setAmount(d, AMT_CALL, -1, 0, 0);
        } else forget(d);
        continue;
      }
      /* add / sub（即値） */
      if (Words.masked(w, 0x1f000000) === 0x11000000) {
        const d = w & 31, a = (w >>> 5) & 31;
        const sub = ((w >>> 30) & 1) === 1;
        if (((w >>> 29) & 1) === 1 && d === 31) continue;      // cmp
        if (pBase[a] >= 0) {
          const imm = ((w >>> 10) & 0xfff) << (((w >>> 22) & 1) ? 12 : 0);
          copy(d, a);
          pDir[d] = sub ? -1 : 1;
          setAmount(d, AMT_IMM, -1, imm, 0);
        } else forget(d);
        continue;
      }
      /* madd / msub — Wd = Wa ± Wn*Wm。倍率つきのダメージはこの形になる。 */
      if (Words.masked(w, 0x1f000000) === 0x1b000000 && ((w >>> 21) & 7) === 0) {
        const d = w & 31, nR = (w >>> 5) & 31, m = (w >>> 16) & 31, a = (w >>> 10) & 31;
        const sub = ((w >>> 15) & 1) === 1;
        if (a !== 31 && pBase[a] >= 0) {
          const src = pBase[nR] >= 0 ? nR : (pBase[m] >= 0 ? m : -1);
          copy(d, a);
          pDir[d] = sub ? -1 : 1;
          if (src >= 0) {
            setAmount(d, AMT_FIELD, pBase[src], pDisp[src], 1, pSize[src], spanOf[pBase[src]]);
          }
        } else forget(d);
        continue;
      }
      /* mul / sdiv / udiv / lsl … — 量に倍率が掛かる。由来は保つ。 */
      if (Words.isMultiply(w) || Words.isDivide(w) || Words.isShiftOp(w)) {
        const d = w & 31, a = (w >>> 5) & 31, m = (w >>> 16) & 31;
        const src = pBase[a] >= 0 ? a : (pBase[m] >= 0 ? m : -1);
        if (src >= 0) { copy(d, src); pAmtScaled[d] = 1; } else forget(d);
        continue;
      }
      /* bic Wd, Wn, Wn, asr #31 — 「0 未満にしない」の定番の書き方 */
      if (Words.masked(w, 0x1f200000) === 0x0a200000) {
        const d = w & 31, a = (w >>> 5) & 31, m = (w >>> 16) & 31;
        if (a === m && ((w >>> 22) & 3) === 2 && ((w >>> 10) & 0x3f) === 31 && pBase[a] >= 0) {
          copy(d, a); pClamp[d] = 1;
        } else forget(d);
        continue;
      }
      /* csel / csinc / csneg — 上限・下限で締める */
      if (Words.masked(w, 0x1fe00000) === 0x1a800000) {
        const d = w & 31, a = (w >>> 5) & 31, m = (w >>> 16) & 31;
        const src = pBase[a] >= 0 ? a : (pBase[m] >= 0 ? m : -1);
        if (src >= 0) { copy(d, src); pClamp[d] = 1; } else forget(d);
        continue;
      }
      /* mov Wd, Wn（orr Wd, wzr, Wn） */
      if (Words.masked(w, 0x7fe0ffe0) === 0x2a0003e0) {
        const d = w & 31, m = (w >>> 16) & 31;
        if (pBase[m] >= 0) copy(d, m); else forget(d);
        continue;
      }
      if (Words.isCompare(w) || Words.isNop(w)) continue;
      forget(w & 31);
    }

    pos += words * 4;
    scanProgress(requestId, epoch, pos, total, n);
    await yieldToQueue();
  }

  const addr = evAddr.slice(0, n), disp = evDisp.slice(0, n), size = evSize.slice(0, n);
  const flags = evFlags.slice(0, n), amtKind = evAmtKind.slice(0, n), amtDisp = evAmtDisp.slice(0, n);
  const span = evSpan.slice(0, n);
  const amtSize = evAmtSize.slice(0, n), amtSpan = evAmtSpan.slice(0, n);
  return {
    regionId, vmAddr: region.vmAddr, count: n, capped, cancelled: false,
    addr, disp, size, flags, amtKind, amtDisp, span, amtSize, amtSpan,
    __transfer: [addr.buffer, disp.buffer, size.buffer, flags.buffer,
      amtKind.buffer, amtDisp.buffer, span.buffer, amtSize.buffer, amtSpan.buffer],
  };
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
async function findFieldAccess({ regionId, offset, size, limit, offsets, requestId, epoch }) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const cap = Math.min(Number(limit) || 2000, 4000);
  const total = Number(region.size);

  /*
   * 複数の位置を 1 回の走査でまとめて調べられるようにしてある。
   * 「HP はこの値か、それともあの値か」を決めるとき、候補ごとに
   * セクションを舐め直すと数十 MB × 候補数になってしまうため。
   */
  const wanted = new Map();          // ずらし幅(string) -> {want, size, out}
  const list = Array.isArray(offsets) && offsets.length
    ? offsets
    : [{ offset, size }];
  for (const it of list) {
    if (it == null || it.offset == null) continue;
    const want = BigInt(it.offset);
    const key = want.toString();
    if (wanted.has(key)) continue;
    wanted.set(key, { want, size: Number(it.size) || 0, out: [] });
  }
  if (!wanted.size) return { results: [], groups: {}, cancelled: false, capped: false };

  const allFull = () => {
    for (const s of wanted.values()) if (s.out.length < cap) return false;
    return true;
  };

  let found = 0;
  let pos = 0;
  while (pos < total && !allFull()) {
    if (cancelled(requestId)) return { results: firstOf(), groups: groupsOf(), cancelled: true };
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
      const slot = wanted.get(mem.disp.toString());
      if (!slot || slot.out.length >= cap) continue;
      // 大きさが分かっているなら、それも合わせる（別の変数を拾わないため）
      if (slot.size > 0 && mem.size !== slot.size && !(slot.size > 8 && mem.size === 8)) continue;
      const byteOff = pos + i * 4;
      slot.out.push({
        row: byteOff / 4,
        addr: region.vmAddr + BigInt(byteOff),
        kind: mem.load ? 'load' : 'store',
        base: mem.base,
        size: mem.size,
      });
      found++;
    }
    pos += words * 4;
    scanProgress(requestId, epoch, pos, total, found);
    await yieldToQueue();
  }
  const capped = Array.from(wanted.values()).some((s) => s.out.length >= cap);
  return { results: firstOf(), groups: groupsOf(), cancelled: false, capped };

  function firstOf() {
    // 1 つだけ頼まれたとき用。これまでの呼び出し元がそのまま動くようにする。
    const first = wanted.values().next().value;
    return first ? first.out : [];
  }
  function groupsOf() {
    const out = {};
    for (const [key, slot] of wanted) out[key] = slot.out;
    return out;
  }
}

/* ── 文字列の抽出 ───────────────────────────────────────────── */

/*
 * 読める文字が min 文字以上続くところを拾う。
 *
 * 「読める」は ASCII だけではない。日本語のアプリの文言は UTF-8 で入っていて、
 * 1 文字が 3 バイトになる。バイトを 1 つずつ ASCII かどうかで見ていると、
 * 「攻撃」も「所持金」も 1 つ残らず落ちる — このツールがいちばん拾いたいものが、
 * まるごと消える。だから UTF-8 の並びとして正しいものは、そのまま文字として認める。
 */
const UTF8 = new TextDecoder('utf-8', { fatal: false });
const MAX_STRING_CHARS = 400;

/**
 * 「そこに置いてある 1 本の文字列」を読む。読めなければ空文字。
 *
 * scanStrings と同じ基準（UTF-8 として正しく、制御文字が混ざっていない）で
 * 判定する。ここが scanStrings とずれていると、「一覧には出るのに、
 * その文字列を参照している関数を開くと出てこない」という食い違いが起きる。
 */
function decodeUtf8Text(bytes) {
  if (!bytes || !bytes.length) return '';
  let n = 0;
  while (n < bytes.length) {
    const c = bytes[n];
    let need;
    if (c < 0x80) {
      if (!((c >= 0x20 && c < 0x7f) || c === 9 || c === 10)) break;
      need = 0;
    } else if (c >= 0xc2 && c <= 0xdf) need = 1;
    else if (c >= 0xe0 && c <= 0xef) need = 2;
    else if (c >= 0xf0 && c <= 0xf4) need = 3;
    else break;
    if (n + need >= bytes.length) break;
    let ok = true;
    for (let k = 1; k <= need; k++) if ((bytes[n + k] & 0xc0) !== 0x80) { ok = false; break; }
    if (!ok) break;
    n += need + 1;
  }
  if (!n) return '';
  return UTF8.decode(bytes.subarray(0, n)).replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

async function scanStrings({ regionId, min, limit, maxBytes, requestId, epoch }) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const minLen = Math.max(2, Number(min) || STRINGS_MIN);
  const cap = Math.min(Number(limit) || STRINGS_LIMIT, STRINGS_LIMIT);
  const regionBytes = Number(region.size);
  const total = Math.min(regionBytes, Math.max(0, Number(maxBytes == null ? regionBytes : maxBytes)));
  const out = [];
  let pos = 0;                 // 次に読むファイル内の位置（region 先頭から）
  let runStart = -1;           // いま伸びている文字列の先頭
  let runBytes = [];

  const flush = () => {
    if (runStart >= 0 && runBytes.length) {
      const text = UTF8.decode(new Uint8Array(runBytes))
        .replace(/\t/g, '\\t').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
      if (text.length >= minLen) {
        out.push({ addr: region.vmAddr + BigInt(runStart), offset: runStart, text });
      }
    }
    runStart = -1;
    runBytes = [];
  };

  /** buf[i] から始まる UTF-8 の並びの長さ。文字として読めないなら 0。 */
  const utf8Len = (buf, i) => {
    const c = buf[i];
    if (c < 0x80) return (c >= 0x20 && c < 0x7f) || c === 9 || c === 10 || c === 13 ? 1 : 0;
    let need = 0;
    if (c >= 0xc2 && c <= 0xdf) need = 1;
    else if (c >= 0xe0 && c <= 0xef) need = 2;
    else if (c >= 0xf0 && c <= 0xf4) need = 3;
    else return 0;
    if (i + need >= buf.length) return -1;               // 続きは次の塊にある
    for (let k = 1; k <= need; k++) {
      if ((buf[i + k] & 0xc0) !== 0x80) return 0;
    }
    return need + 1;
  };

  let carry = new Uint8Array(0);
  let carryAt = 0;
  while (pos < total && out.length < cap) {
    if (cancelled(requestId)) return { results: out, cancelled: true, capped: false, scannedBytes: pos, complete: false };
    const want = Math.min(SCAN_BLOCK, total - pos);
    const blk = await readRange(region.fileOffset + BigInt(pos), want);
    if (!blk.length) break;
    let buf = blk, baseOff = pos;
    if (carry.length) {
      buf = new Uint8Array(carry.length + blk.length);
      buf.set(carry, 0);
      buf.set(blk, carry.length);
      baseOff = carryAt;
    }
    const last = pos + blk.length >= total;
    let i = 0;
    for (; i < buf.length; i++) {
      const n = utf8Len(buf, i);
      if (n === -1 && !last) break;                      // 途中で切れた。次の塊と合わせる
      if (n <= 0) { flush(); if (out.length >= cap) break; continue; }
      if (runStart < 0) { runStart = baseOff + i; runBytes = []; }
      if (runBytes.length < MAX_STRING_CHARS * 4) {
        for (let k = 0; k < n; k++) runBytes.push(buf[i + k]);
      }
      i += n - 1;
    }
    carry = i < buf.length ? buf.subarray(i) : new Uint8Array(0);
    carryAt = baseOff + i;
    pos += blk.length;
    scanProgress(requestId, epoch, pos, total, out.length);
    await yieldToQueue();
  }
  flush();
  return {
    results: out.slice(0, cap), cancelled: false, capped: out.length >= cap,
    truncationReason: out.length >= cap ? 'result-limit' : (total < regionBytes ? 'input-budget' : null),
    scannedBytes: pos, complete: pos >= regionBytes && out.length < cap,
  };
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
async function findXrefs({ regionId, target, limit, requestId, epoch }) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
  const want = BigInt(target);
  const cap = Math.min(Number(limit) || XREF_LIMIT, XREF_LIMIT);
  const total = Number(region.size);
  const out = [];

  const provenance = AddressProvenance.create({
    words: Words,
    pairWindow: PAIR_WINDOW,
    functionStarts: functionStartsForRegion(region),
    rangeStart: region.vmAddr,
    rangeEnd: region.vmAddr + region.size,
  });
  let index = 0;

  let pos = 0;
  while (pos < total && out.length < cap) {
    if (cancelled(requestId)) return { results: out, cancelled: true, capped: false };
    const wantBytes = Math.min(SCAN_BLOCK, total - pos);
    const blk = await readRange(region.fileOffset + BigInt(pos), wantBytes);
    if (blk.length < 4) break;
    const words = Math.floor(blk.length / 4);
    const dv = new DataView(blk.buffer, blk.byteOffset, words * 4);
    for (let i = 0; i < words; i++, index++) {
      const w = dv.getUint32(i * 4, true);
      const byteOff = pos + i * 4;
      const pc = region.vmAddr + BigInt(byteOff);
      provenance.enter(pc);

      const direct = wordTarget(w, pc);
      if (direct !== null && direct === want) {
        out.push({ row: byteOff / 4, addr: pc, kind: 'branch' });
        if (out.length >= cap) break;
      }
      const kind = Words.classifyWord(w);
      if (kind === Words.KIND.CALL || kind === Words.KIND.INDCALL ||
          kind === Words.KIND.CONDBR || kind === Words.KIND.BRANCH ||
          kind === Words.KIND.RET || kind === Words.KIND.TRAP) {
        provenance.control(w, pc, kind);
        continue;
      }
      const rel = pcRelTarget(w, pc);
      if (rel) {
        provenance.note(rel.reg, rel.value, index);
        if (!rel.page && rel.value === want) {
          out.push({ row: byteOff / 4, addr: pc, kind: 'address' });
          if (out.length >= cap) break;
        }
        continue;
      }
      const pair = pairedOffset(w);
      const base = pair ? provenance.base(pair.rn, index) : null;
      if (pair && base != null) {
        const full = base + pair.imm;
        if (full === want) {
          out.push({
            row: byteOff / 4, addr: pc,
            kind: pair.load ? 'load' : pair.store ? 'store' : 'address',
          });
          if (out.length >= cap) break;
        }
        if (!pair.load && !pair.store) provenance.note(pair.rd, full, index);
        else if (pair.load && pair.gpDest !== false) provenance.kill(pair.rd);
        continue;
      }
      const memWrite = Words.memoryAccess(w);
      if (memWrite) {
        // FP/SIMD register numbers share the low encoding bits with xN/wN, but
        // writing d8/q8 must not destroy an address held in x8.  Conversely,
        // integer pair loads can overwrite both GP destinations, and pre/post
        // indexed memory operations overwrite their base register.
        if (memWrite.load && !memWrite.vector) {
          provenance.kill(memWrite.reg);
          if (memWrite.pair && memWrite.reg2 != null) provenance.kill(memWrite.reg2);
        }
        if (memWrite.mode === 'pre' || memWrite.mode === 'post') provenance.kill(memWrite.base);
        continue;
      }
      if (kind === Words.KIND.FARITH || kind === Words.KIND.FMUL || kind === Words.KIND.SIMD ||
          (kind === Words.KIND.CSEL && Words.isFpCondSelect?.(w))) continue;
      if (WRITES_LOW_REG[kind]) provenance.kill(w & 0x1f);
    }
    pos += words * 4;
    scanProgress(requestId, epoch, pos, total, out.length);
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
    /*
     * ASCII だけを文字列として認めていたころ、日本語のアプリでは
     * 参照している文言がほぼ全部「文字列ではない」として捨てられていた。
     *
     *   「攻撃力アップ:%d 基ダ×(100+%d)÷100」  → 1 バイト目が 0xE6 → 捨てる
     *
     * この 1 行のせいで、開発者が計算式そのものを書き残している関数を
     * 「参照している文言はありません」と説明していた。UTF-8 として読む。
     */
    const end = result.bytes.indexOf(0);
    const body = end >= 0 ? result.bytes.subarray(0, end) : result.bytes;
    result.text = decodeUtf8Text(body);
    result.terminated = end >= 0;
  }
  result.__transfer = [result.bytes.buffer];
  return result;
}

/* ── search ─────────────────────────────────────────────────── */

async function runSearch({ regionId, kind, query, hex, from, requestId, epoch }) {
  const region = regions.get(regionId);
  if (!region) throw new Error('Unknown region.');
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
      if (cancelled(requestId)) return { cancelled: true, results, scanned };
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
      if (cancelled(requestId)) return { cancelled: true, results, scanned };
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
      if (cancelled(requestId)) return { cancelled: true, results, scanned };
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
    self.postMessage({ t: 'searchProgress', requestId, epoch, done, all, hits });
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
