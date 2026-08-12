/*
 * 実物のバイナリで、実物のパイプラインを回すための足場（Node 用）。
 *
 * ブラウザでしか動かないツールは、精度を測れない。測れないものは良くならない。
 * ここは js/worker.js をそのまま Node の中で動かして、Backend と同じ形の
 * 入口を返す。つまり画面と同じコードが、同じ順番で走る。
 *
 *   const world = await openBinary('tests/battlecats');
 *   world.fields / world.program / world.strings / world.analyze(addr)
 *
 * 使い方: node tests/probe.mjs tests/battlecats
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/* ── worker.js（classic script）を Node の中で起こす ─────────── */

let booted = false;
const pending = new Map();
let seq = 1;

function loadClassic(file, tail) {
  const src = fs.readFileSync(file, 'utf8');
  const wrapper = vm.runInThisContext(
    '(function(require,__dirname,__filename,module,exports){' + src + '\n' + (tail || '') + '\n})',
    { filename: file });
  const mod = { exports: {} };
  wrapper(require, path.dirname(file), file, mod, mod.exports);
}

function boot() {
  if (booted) return;
  booted = true;
  globalThis.self = globalThis;
  globalThis.location = { href: pathToFileURL(path.join(ROOT, 'js', 'worker.js')).href };
  globalThis.importScripts = (...ps) => {
    for (const p of ps) {
      const file = path.resolve(ROOT, 'js', p);
      loadClassic(file, /capstone/.test(p) ? 'globalThis.MCapstone = MCapstone;' : '');
    }
  };
  globalThis.postMessage = (m) => {
    if (!m || m.id == null) return;                  // 進捗などは捨てる
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.t === 'ok') p.resolve(m.result);
    else p.reject(new Error(m.error || 'failed'));
  };
  loadClassic(path.join(ROOT, 'js', 'worker.js'));
}

function call(t, payload) {
  boot();
  const id = seq++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    globalThis.self.onmessage({ data: Object.assign({ t, id }, payload) });
  });
}

/** File / Blob の代わり。worker が使うのは size と slice().arrayBuffer() だけ。 */
function fileShim(p) {
  const buf = fs.readFileSync(p);
  return {
    name: path.basename(p),
    size: buf.length,
    slice(a, b) {
      const s = buf.subarray(a, b);
      return { arrayBuffer: async () => s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength) };
    },
  };
}

/* ── Backend と同じ形の入口 ──────────────────────────────────── */

export class NodeBackend {
  open(f) { return call('open', { file: f }); }
  analyze(sliceIndex) { return call('analyze', { sliceIndex }); }
  guessFunctions(regionId, limit) { return call('guessFunctions', { regionId, limit }); }
  scanProgram(regionId) { return call('scanProgram', { regionId }); }
  fieldAccess(params) { return call('fieldAccess', params); }
  valueShapes(regionId) { return call('valueShapes', { regionId }); }
  fieldAccessMany(regionId, offsets) {
    return call('fieldAccess', { regionId, offsets }).then((res) => {
      const out = new Map();
      const groups = (res && res.groups) || {};
      for (const k of Object.keys(groups)) out.set(k, groups[k]);
      return out;
    });
  }
  strings(params) { return call('strings', params); }
  xrefs(params) { return call('xrefs', params); }
  readAt(addr, len, text) { return call('readAt', { addr, len, text }); }
  fetchChunk(regionId, chunk, wantAsm) {
    return call('chunk', { regionId, chunk, wantAsm }).then((res) => ({
      bytes: res.bytes, rows: res.rows,
      mn: res.mn ? res.mn.split('\n') : null,
      ops: res.ops ? res.ops.split('\n') : null,
    }));
  }
}

/**
 * バイナリを開いて、画面と同じ索引をひととおり作る。
 *
 * @param {string} file  バイナリのパス
 * @param {object} [opts] { objc: false でクラス表を読まない, log }
 */
export async function openBinary(file, opts) {
  const o = opts || {};
  const log = o.log || (() => {});
  const backend = new NodeBackend();
  const info = await backend.open(fileShim(path.resolve(ROOT, file)));

  const slice = info.slices[0] || null;
  const regions = [].concat(...info.slices.map((s) => s.regions), [info.raw]);
  const region = regions.find((r) => r.section === '__text' && r.size > 0n) ||
    regions.find((r) => r.exec && r.size > 0n);

  const { SymbolIndex } = await import('../js/symbols.js');
  const { ProgramIndex } = await import('../js/program.js');
  const { FieldIndex } = await import('../js/fields.js');
  const { buildObjcModel } = await import('../js/objc.js');
  const { analyzeFunctionCached } = await import('../js/analyze.js');

  log('symbols…');
  const symRes = await backend.analyze(0);
  const symbols = new SymbolIndex(symRes);

  let objcModel = null;
  let fields = new FieldIndex(null);
  if (o.objc !== false) {
    const list = regions.find((r) => r.section === '__objc_classlist' && r.size > 0n);
    if (list) {
      log('objc…');
      const read = (addr, len) => backend.readAt(addr, len)
        .then((r) => (r && r.found ? r.bytes : null)).catch(() => null);
      try {
        objcModel = await buildObjcModel(read, list, null,
          slice && slice.info ? slice.info.textVM : null);
        fields = new FieldIndex(objcModel);
        if (objcModel.names.length) {
          symbols.addNames(objcModel.names);
          symbols.addFunctions(objcModel.names.map((n) => n.addr));
        }
      } catch (err) { log('objc failed: ' + err.message); }
    }
  }

  log('scan…');
  const scan = await backend.scanProgram(region.id);
  const program = new ProgramIndex(scan, symbols, region);

  let strings = [];
  if (o.strings !== false) {
    log('strings…');
    /* 画面と同じ選び方（app.js ensureStrings）。ここがずれると精度を測れない。 */
    const targets = regions.filter((r) => r.size > 0n &&
      (r.cstrings || /string|cstring|objc_method|objc_class|const|ustring|swift5_reflstr/i.test(r.section || '')));
    let budget = 64 * 1024 * 1024;
    for (const r of targets) {
      if (budget <= 0) break;
      budget -= Number(r.size);
      const res = await backend.strings({ regionId: r.id, min: 4 });
      for (const s of res.results) strings.push({ addr: s.addr, text: s.text, region: r });
    }
  }

  /* panels.js の makeAnalyzer と同じ形にそろえる（画面と違う結果を測っても意味がない）。 */
  const totalRows = Number(region.size / 4n);
  const analyze = async (addr, end) => {
    const startRow = Number((BigInt(addr) - region.vmAddr) / 4n);
    if (!(startRow >= 0) || startRow >= totalRows) return null;
    /* 画面（app.js analyzeFunctionAt）と同じで、既定はその関数の終わりまで。 */
    let stop = end;
    if (stop == null) {
      const fn = symbols.functionAt(BigInt(addr));
      if (fn && fn.end != null) stop = fn.end;
    }
    const endRow = stop != null
      ? Math.min(totalRows - 1, Number((BigInt(stop) - region.vmAddr) / 4n) - 1)
      : Math.min(totalRows - 1, startRow + 512);
    if (endRow < startRow) return null;
    const res = await analyzeFunctionCached(backend, region, startRow, endRow, symbols, null, { texts: false });
    return res.model;
  };
  function rowOf(addr) { return Number((BigInt(addr) - region.vmAddr) / 4n); }

  return {
    info, slice, regions, region, backend, symbols, fields, objcModel,
    program, strings, scan, analyze, rowOf,
    scanAccess: (list) => backend.fieldAccessMany(region.id, list),
  };
}
