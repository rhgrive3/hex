/*
 * Analysis worker: file I/O, Mach-O parsing, Capstone disassembly, search.
 * Runs off the main thread so scrolling and tapping never wait on it.
 *
 * Classic worker (not a module) because capstone.js is a UMD bundle that has
 * to come in through importScripts().
 */
'use strict';

importScripts('./macho.js', '../capstone.js');

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

/* ── State ──────────────────────────────────────────────────── */

let file = null;
let fileSize = 0n;
let regions = new Map();
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
