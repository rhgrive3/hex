/*
 * スクリプト（自動化）。IDAPython にあたるものです。
 *
 * 同じ作業を何百回も繰り返すとき、手で押していては終わりません。
 * 「名前に Login を含む関数を全部あげて、それぞれの呼び出し元を数える」
 * といったことを、数行で書けるようにします。言語は JavaScript です
 * （ブラウザの中で動くので、Python ではなくこちらを使います）。
 *
 * 例:
 *
 *   // 名前に "damage" が入る関数を探す
 *   for (const f of await hex.functions()) {
 *     if (f.name && f.name.includes('damage')) print(hex.hex(f.addr), f.name);
 *   }
 *
 *   // ある関数の逆コンパイル結果を表示する
 *   print(await hex.decompile(0x1000A3C0));
 *
 *   // 名前を付ける
 *   await hex.rename(0x1000A3C0, 'ダメージ計算');
 *
 * opaque-origin sandboxとCSPで、外へ通信する手段（fetch など）は使えません。
 * ファイルの中身も、あなたの端末から出ません。
 */

import { decompile, decompiledText } from './decompile.js';
import { readableName } from './rtti.js';
import { inferTypes, recoverStruct } from './types.js';
import { parseHexBytes, isHexBytes, validatePatchRange } from './patch.js';
import { architectureAdapter, unsupportedArchitectureResult, UnsupportedArchitectureError } from './architecture/index.js';
import { Emulator } from './emu.js';

export { UnsupportedArchitectureError } from './architecture/index.js';
import { runInSandbox } from './sandbox.js';

/**
 * スクリプトから触れる道具一式を作る。
 * @param {object} app
 * @param {function} out 1 行出力する関数
 */
export function createApi(app, out) {
  const print = (...args) => {
    out(args.map((a) => format(a)).join(' '));
  };

  const region = () => app.codeRegion();
  const architecture = () => String(
    app.store.get('architecture') || app.currentSlice?.()?.capability?.architecture || 'unknown'
  ).toLowerCase();
  const adapter = () => architectureAdapter(architecture());
  const rowOf = (addr) => adapter().rowForAddress(region(), BigInt(addr));
  const addressOfRow = (row) => adapter().addressForRow(region(), row);

  /*
   * Stateful objects cannot cross MessageChannel because methods/functions are
   * not structured-cloneable. Keep Emulator instances on the trusted side and
   * expose opaque handles. sandbox.js turns the handle back into an ergonomic
   * proxy for scripts (`const e = await hex.emulator()`).
   */
  const emulators = new Map();
  let emulatorSeq = 1;
  const MAX_EMULATORS = 16;
  const MAX_EMULATOR_STEPS = 100000;
  const MAX_EMULATOR_DUMP = 1024 * 1024;

  const emulatorOf = (id) => {
    const emu = emulators.get(String(id || ''));
    if (!emu) throw new Error('そのエミュレータは終了済みか、存在しません。');
    return emu;
  };
  const emulatorState = (emu) => ({
    x0: emu.x[0] || 0n,
    pc: emu.pc, sp: emu.sp, steps: emu.steps, stopped: emu.stopped,
    flags: emu.flagText(), regs: emu.registerList(),
    log: emu.log.slice(-256),
    callStack: emu.callStack.slice(-256),
    trace: emu.trace.slice(-256),
  });
  const boundedSteps = (n) => Math.max(1, Math.min(MAX_EMULATOR_STEPS, Math.trunc(Number(n) || 20000)));

  const api = {
    /* ── 基本 ─────────────────────────────────────────── */

    /** 数を 0x… の文字列にする。 */
    hex(v, pad = 8) { return '0x' + BigInt(v).toString(16).toUpperCase().padStart(pad, '0'); },

    /** 開いているファイルの情報。 */
    file() {
      const info = app.store.get('fileInfo');
      const f = app.store.get('file');
      const slice = app.currentSlice();
      return {
        name: f ? f.name : null,
        size: f ? f.size : 0,
        arch: app.store.get('architecture'),
        uuid: slice && slice.info ? slice.info.uuid : null,
        platform: slice && slice.info ? slice.info.platform : null,
        dylibs: slice && slice.info ? slice.info.dylibs : [],
        sections: (app.store.get('regions') || []).map((r) => ({
          name: r.name, addr: r.vmAddr, size: r.size, exec: !!r.exec,
        })),
        raw: info,
      };
    },

    /* ── 関数 ─────────────────────────────────────────── */

    /** 関数の一覧。[{addr, name, size}] */
    functions(limit = 100000) {
      const r = region();
      return app.symbols.functionList(r, limit);
    },

    /** そのアドレスの関数名（自分で付けた名前が優先）。 */
    name(addr) {
      const a = BigInt(addr);
      return app.symbols.nameAt(a) || app.symbols.label(a) || null;
    },

    /** 読める形にした名前（C++ / Swift のマングル解除つき）。 */
    readableName(addr) {
      const n = api.name(addr);
      return n ? readableName(n) : null;
    },

    /** 名前を付ける（IDA の Rename）。 */
    rename(addr, name) {
      const a = BigInt(addr);
      app.notes.setName(a, name);
      app.symbols.rename(a, name);
      app.viewer.setSymbols(app.symbols);
      return true;
    },

    /** その行にメモを書く。 */
    comment(addr, text) {
      app.notes.setComment(BigInt(addr), text);
      return true;
    },

    /** そのアドレスを含む関数の {start, end}。 */
    functionAt(addr) {
      /* Bind containment to the active slice's executable regions before lookup. */
      app.symbols.setFunctionRegions(app.store.get('regions') || [], false);
      return app.symbols.functionAt(BigInt(addr));
    },

    /* ── 中身を読む ───────────────────────────────────── */

    /** 生バイトを読む。 */
    async bytes(addr, len = 16) {
      const r = await app.backend.readAt(BigInt(addr), len);
      return r && r.found ? r.bytes : null;
    },

    /** 0 終端の文字列として読む。 */
    async string(addr, max = 200) {
      const r = await app.backend.readAt(BigInt(addr), max, true);
      return r && r.found ? (r.text || null) : null;
    },

    /** 逆アセンブル。[{addr, mn, ops}] */
    async disasm(addr, count = 16) {
      const r = region();
      if (!r) return [];
      const a = BigInt(addr);
      const arch = architecture();
      const archAdapter = adapter();
      const limit = Math.max(0, Math.min(10000, Math.trunc(Number(count) || 0)));
      if (!limit) return [];

      // Fixed-size legacy viewers have a stable row<->address mapping owned by
      // the architecture adapter. Variable-length ISAs must use decoder output.
      if (archAdapter.fixedInstructionSize != null) {
        const out2 = [];
        let row = rowOf(a);
        if (row == null) return [];
        for (let i = 0; i < limit; i++, row++) {
          const instructionAddress = addressOfRow(row);
          if (instructionAddress == null) break;
          const chunk = Math.floor(row / 1024);
          const e = await app.backend.fetchChunk(r.id, chunk, true);
          const k = row - chunk * 1024;
          if (!e.mn || !e.mn[k]) break;
          out2.push({ addr:instructionAddress, mn:e.mn[k], ops:e.ops ? e.ops[k] : '' });
        }
        return out2;
      }

      if (typeof app.backend.disassembleAt !== 'function') return unsupportedArchitectureResult('disassemble', arch);
      const decoded = await app.backend.disassembleAt(a, {
        architecture:arch,
        length:Math.min(1024 * 1024, Math.max(64, limit * 16)),
      });
      if (!decoded?.supported) return unsupportedArchitectureResult('disassemble', arch);
      return (decoded.instructions || []).slice(0, limit).map((instruction) => ({
        addr:BigInt(instruction.address),
        size:Number(instruction.size || 0),
        mn:instruction.mnemonic || '',
        ops:instruction.opStr || '',
      }));
    },

    /** 逆コンパイル結果（文字列）。 */
    async decompile(addr) {
      const res = await app.analyzeFunctionAt(BigInt(addr));
      if (!res) return null;
      const r = region();
      const out2 = decompile(res.model, {
        name: api.name(addr), addr: BigInt(addr),
        rowOfAddress: (a) => rowOf(a),
        addrOfRow: (row) => r.vmAddr + BigInt(row) * 4n,
        symbolFor: (a) => app.symbols.nameAt(a),
        notes: app.notes,
      });
      return decompiledText(out2);
    },

    /** 引数・戻り値・ローカル変数の推定。 */
    async types(addr) {
      const res = await app.analyzeFunctionAt(BigInt(addr));
      return res ? inferTypes(res.model) : null;
    },

    /** 構造体の自動復元。 */
    async struct(addr, reg) {
      const res = await app.analyzeFunctionAt(BigInt(addr));
      return res ? recoverStruct(res.model, reg) : null;
    },

    /* ── 参照関係 ─────────────────────────────────────── */

    /** そのアドレスを呼んでいる場所。 */
    xrefsTo(addr, limit = 200) {
      const p = app.program;
      if (!p) return [];
      const a = BigInt(addr);
      return p.callSitesTo(a, limit).concat(p.refSitesTo(a, 1n, limit));
    },

    /** その関数が呼んでいる先。 */
    xrefsFrom(addr, limit = 200) {
      const p = app.program;
      if (!p) return [];
      const range = p.functionRange(BigInt(addr));
      if (!range) return [];
      return p.calleesOf(range.start, range.end, limit);
    },

    /** よく呼ばれている関数の順位。 */
    mostCalled(limit = 20) { return app.program ? app.program.mostCalled(limit) : []; },

    /* ── 文字列 ───────────────────────────────────────── */

    /** 集めた文字列（あらかじめ「文字列」画面を開くか、await hex.loadStrings() が要る）。 */
    strings() { return app.stringIndex || []; },

    async loadStrings() { return app.ensureStrings(); },

    /** 文字列を検索する。 */
    findStrings(query, limit = 200) {
      const q = String(query).toLowerCase();
      return (app.stringIndex || []).filter((s) => s.text.toLowerCase().includes(q)).slice(0, limit);
    },

    /* ── Objective-C ──────────────────────────────────── */

    /** クラス一覧。 */
    classes() {
      const m = app.objcModel;
      return m ? m.classes.map((c) => ({ name: c.name, superclass: c.superclass, methods: c.methods.length, ivars: c.ivars.length })) : [];
    },

    /** クラス 1 つの中身。 */
    classInfo(name) { return app.fields ? app.fields.classInfo(name) : null; },

    /* ── 書き換え ─────────────────────────────────────── */

    /** 現在のarchitecture用に命令を組み立てる。 */
    assemble(text, at) {
      const arch = architecture();
      const archAdapter = adapter();
      if (typeof archAdapter.assemble !== 'function') return unsupportedArchitectureResult('assemble', arch);
      return archAdapter.assemble(text, BigInt(at));
    },

    /** 書き換えを登録する（保存するまでファイルは変わりません）。 */
    async patch(addr, textOrHex) {
      const a = BigInt(addr);
      const r = region();
      if (!r) return { error: 'セクションが選ばれていません。' };
      const raw = isHexBytes(textOrHex);
      const arch = architecture();
      const archAdapter = adapter();
      let built;
      if (raw) built = { bytes:parseHexBytes(textOrHex) };
      else {
        if (typeof archAdapter.assemble !== 'function') return unsupportedArchitectureResult('assemble', arch);
        built = archAdapter.assemble(textOrHex, a);
      }
      if (!built?.bytes) return built;
      if (!raw) {
        const placement = archAdapter.validateInstructionPlacement(r, a, built.bytes.length);
        if (!placement?.ok) return placement;
      }
      const file = app.store.get('file');
      // Explicit raw bytes are ISA-neutral and may be any in-range length/alignment.
      const valid = validatePatchRange(r, a, built.bytes.length, file && file.size, false);
      if (valid.error) return valid;
      const before = await api.bytes(a, built.bytes.length);
      if (!before || before.length !== built.bytes.length) return { error: '元のバイトを読み取れません。' };
      const mode = raw ? 'raw' : 'assembly';
      app.patches.add(valid.fileOffset, before, built.bytes, { addr:a, text:textOrHex, mode, architecture:arch });
      return { ok:true, bytes:built.bytes, mode, architecture:arch };
    },

    /* ── 実行してみる ─────────────────────────────────── */

    /**
     * 関数を動かしてみる。
     * @returns {{x0, steps, stopped, log}}
     */
    async run(addr, args = [], maxSteps = 20000) {
      const emu = makeEmulator(app);
      emu.setup(BigInt(addr), args.map((v) => BigInt(v)));
      await emu.run(boundedSteps(maxSteps));
      return {
        x0: emu.x[0], steps: emu.steps, stopped: emu.stopped,
        log: emu.log.slice(-256), regs: emu.registerList(),
      };
    },

    /**
     * Stateful emulator for scripts. Only the handle crosses the sandbox RPC;
     * sandbox.js presents it as an object with setup/step/run/get/set/... methods.
     */
    emulatorCreate(addr = null, args = []) {
      if (emulators.size >= MAX_EMULATORS) throw new Error('同時に作れるエミュレータは16個までです。');
      const emu = makeEmulator(app);
      if (addr != null) emu.setup(BigInt(addr), (args || []).map((v) => BigInt(v)));
      const id = 'emu' + emulatorSeq++;
      emulators.set(id, emu);
      return { id, state: emulatorState(emu) };
    },

    /* Direct callers get the same clone-safe descriptor. In the sandbox, the
       special `hex.emulator()` proxy calls emulatorCreate automatically. */
    emulator(addr = null, args = []) { return api.emulatorCreate(addr, args); },

    emulatorSetup(id, addr, args = []) {
      const emu = emulatorOf(id);
      emu.setup(BigInt(addr), (args || []).map((v) => BigInt(v)));
      return emulatorState(emu);
    },

    async emulatorStep(id) {
      const emu = emulatorOf(id);
      const result = await emu.step();
      return { result, state: emulatorState(emu) };
    },

    async emulatorRun(id, maxSteps = 20000) {
      const emu = emulatorOf(id);
      const result = await emu.run(boundedSteps(maxSteps));
      return { result, state: emulatorState(emu) };
    },

    emulatorState(id) { return emulatorState(emulatorOf(id)); },
    emulatorGetRegister(id, reg) { return emulatorOf(id).get(String(reg || '')); },
    emulatorSetRegister(id, reg, value) {
      const emu = emulatorOf(id);
      emu.set(String(reg || ''), BigInt(value));
      return emu.get(String(reg || ''));
    },

    async emulatorDump(id, addr, len = 64) {
      const n = Math.max(0, Math.min(MAX_EMULATOR_DUMP, Math.trunc(Number(len) || 0)));
      return emulatorOf(id).dump(BigInt(addr), n);
    },

    async emulatorStore(id, addr, size, value) {
      const n = Math.trunc(Number(size));
      if (![1, 2, 4, 8].includes(n)) throw new Error('書き込みサイズは 1 / 2 / 4 / 8 バイトだけ使えます。');
      await emulatorOf(id).store(BigInt(addr), n, BigInt(value));
      return true;
    },

    emulatorAddBreakpoint(id, addr) {
      const emu = emulatorOf(id);
      emu.breakpoints.add(BigInt(addr).toString());
      return true;
    },
    emulatorRemoveBreakpoint(id, addr) {
      const emu = emulatorOf(id);
      return emu.breakpoints.delete(BigInt(addr).toString());
    },
    emulatorBreakpoints(id) { return Array.from(emulatorOf(id).breakpoints, (v) => BigInt(v)); },
    emulatorReset(id) { const emu = emulatorOf(id); emu.reset(); return emulatorState(emu); },
    emulatorDestroy(id) { return emulators.delete(String(id || '')); },

    /* ── 画面を動かす ─────────────────────────────────── */

    goto(addr) { app.goToAddress(BigInt(addr)); return true; },

    open(addr) { app.openFunctionReport(BigInt(addr)); return true; },
  };

  return { api, print };
}

/** app からエミュレータを作る（画面側でも使う）。 */
export function makeEmulator(app) {
  // Legacy callers predate architecture metadata and were ARM64-only. Keep that
  // compatibility path, while explicit unknown/foreign architectures fail closed.
  const detectedArchitecture = app.store.get('architecture') || app.currentSlice?.()?.capability?.architecture;
  const architecture = String(detectedArchitecture || 'arm64').toLowerCase();
  const adapter = architectureAdapter(architecture);
  if (adapter.id !== 'arm64') throw new UnsupportedArchitectureError('emulate', architecture);
  const regions = (app.store.get('regions') || []).filter((r) => r.exec && r.size > 0n);
  const regionAt = (addr) => regions.find((r) => addr >= r.vmAddr && addr < r.vmAddr + r.size) || null;
  return new Emulator({
    read: (addr, len) => app.backend.readAt(addr, len)
      .then((r) => (r && r.found ? r.bytes : null)).catch(() => null),
    fetch: async (addr) => {
      const r = regionAt(addr);
      if (!r) return null;
      const row = adapter.rowForAddress(r, addr);
      if (row == null) return null;
      const chunk = Math.floor(row / 1024);
      const e = await app.backend.fetchChunk(r.id, chunk, true);
      const k = row - chunk * 1024;
      return { mn: e.mn ? e.mn[k] : '', ops: e.ops ? e.ops[k] : '' };
    },
    isExecutable: (addr) => !!regionAt(addr),
    symbolFor: (addr) => app.symbols.nameAt(addr),
    labelFor: (addr) => app.symbols.label(addr),
  });
}

/** 何を渡されても、1 行の文字列にする。 */
function format(v) {
  if (v == null) return String(v);
  if (typeof v === 'bigint') return '0x' + v.toString(16).toUpperCase();
  if (typeof v === 'string') return v;
  if (v instanceof Uint8Array) {
    return Array.from(v.slice(0, 64)).map((b) => b.toString(16).padStart(2, '0')).join(' ') +
      (v.length > 64 ? ' …' : '');
  }
  if (Array.isArray(v)) return '[' + v.slice(0, 20).map(format).join(', ') + (v.length > 20 ? ', …' : '') + ']';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v, (k, val) => (typeof val === 'bigint' ? '0x' + val.toString(16).toUpperCase() : val), 1);
    } catch { return String(v); }
  }
  return String(v);
}

/**
 * スクリプトを走らせる。
 * @param {string} code
 * @param {object} app
 * @param {function} out 出力を受け取る
 */
export async function runScript(code, app, out) {
  const { api, print } = createApi(app, out);
  return runInSandbox({ source: code, mode: 'script', api, out: (...args) => print(...args) });
}

/* ── はじめての人のためのお手本 ─────────────────────────── */

export const SAMPLES = [
  {
    title: 'よく呼ばれている関数を 20 個',
    why: 'アプリの本筋は、たいてい「たくさん呼ばれている関数」の中にあります。',
    code: `for (const f of await hex.mostCalled(20)) {
  print(hex.hex(f.addr), ((await hex.name(f.addr)) || '(名前なし)'), f.count + ' 回');
}`,
  },
  {
    title: '名前で関数を探す',
    why: '知りたい言葉（login, damage, purchase…）で関数を絞り込みます。',
    code: `const word = 'init';
let n = 0;
for (const f of await hex.functions()) {
  if (f.name && f.name.toLowerCase().includes(word)) { print(hex.hex(f.addr), f.name); if (++n >= 30) break; }
}
print('見つかった数:', n);`,
  },
  {
    title: '逆コンパイル結果を見る',
    why: 'アドレスを 1 つ決めて、C 風の書き方で読みます。',
    code: `const f = (await hex.functions())[0];
print(hex.hex(f.addr), f.name || '');
print(await hex.decompile(f.addr));`,
  },
  {
    title: '動かしてみる（引数を変えて）',
    why: '同じ関数に違う値を渡して、戻り値がどう変わるかを見ます。',
    code: `const addr = (await hex.functions())[0].addr;
for (const v of [0, 1, 100]) {
  const r = await hex.run(addr, [v], 5000);
  print('引数', v, '→ 戻り値', r.x0, '(' + r.steps + ' 命令)');
}`,
  },
  {
    title: '文字列を使っている関数を数える',
    why: '「どの画面の文字がどこで使われているか」をたどります。',
    code: `await hex.loadStrings();
const hits = await hex.findStrings('error', 10);
for (const s of hits) {
  const refs = await hex.xrefsTo(s.addr, 20);
  print(JSON.stringify(s.text).slice(0, 40), '→ 参照', refs.length, '件');
}`,
  },
];