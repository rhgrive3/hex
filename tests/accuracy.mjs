/*
 * 精度の物差し。
 *
 *   python3 tests/oracle.py tests/battlecats tests/oracle.battlecats.json.gz   # 1 回だけ
 *   node --max-old-space-size=8000 tests/accuracy.mjs
 *
 * tests/oracle.py が別実装（python + lief + capstone）で作った「本当はこう」と、
 * このツール（js/, 画面と同じコード）が言うことを機能ごとに突き合わせる。
 *
 * 出るのは機能ごとの割合ひとつだけ。ここが上がっていないなら、
 * どんな理屈をつけても精度は上がっていない。
 *
 *   node tests/accuracy.mjs --only=objc,calls    測る機能を絞る
 *   node tests/accuracy.mjs --json               機械が読む形で出す
 *   node tests/accuracy.mjs --save=before.json   あとで比較するために残す
 *   node tests/accuracy.mjs --base=before.json   前回との差を出す
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBinary } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const flag = (name) => argv.includes('--' + name);

const TARGET = opt('target', 'tests/battlecats');
const ORACLE = opt('oracle', 'tests/oracle.' + path.basename(TARGET) + '.json.gz');
const ONLY = (opt('only', '') || '').split(',').filter(Boolean);

/* ── 小道具 ─────────────────────────────────────────────────── */

const pct = (x) => (x * 100).toFixed(1) + '%';
function f1(tp, fp, fn) {
  const prec = tp + fp ? tp / (tp + fp) : 0;
  const rec = tp + fn ? tp / (tp + fn) : 0;
  return { prec, rec, f1: prec + rec ? (2 * prec * rec) / (prec + rec) : 0 };
}
/** 決定的な間引き（毎回同じ標本を見る）。 */
function stride(list, n) {
  if (list.length <= n) return list.slice();
  const step = list.length / n;
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.floor(i * step)]);
  return out;
}

/* ── 機能の定義 ─────────────────────────────────────────────── */

const FEATURES = [];
function feature(id, label, fn, opts) {
  FEATURES.push(Object.assign({ id, label, fn }, opts || {}));
}

/* 1. Mach-O の区画を読めているか */
feature('sections', 'Mach-O の区画を読む', async ({ w, o }) => {
  const want = o.sections.filter((s) => s.size > 0);
  const have = new Map();
  for (const r of w.regions) {
    if (r.section) have.set(r.segment + '/' + r.section, r);
  }
  let hit = 0, wrong = 0;
  for (const s of want) {
    const r = have.get(s.seg + '/' + s.sec);
    if (!r) continue;
    // zerofill の区画はファイルに実体がない。宣言された大きさで見る。
    const size = Number(r.size) || Number(r.declaredSize || 0n);
    if (Number(r.vmAddr) === s.vm && size === s.size) hit++;
    else wrong++;
  }
  return { score: hit / want.length, detail: `${hit}/${want.length} 一致（ずれ ${wrong}）` };
});

/* 2. 関数の切れ目 */
feature('funcs', '関数の切れ目を見つける', async ({ w, o }) => {
  const truth = new Set(o.functionStarts);
  let tp = 0, fp = 0;
  for (const a of w.symbols.funcs) {
    if (truth.has(Number(a))) tp++; else fp++;
  }
  const r = f1(tp, fp, truth.size - tp);
  return { score: r.f1, detail: `適合 ${pct(r.prec)} / 再現 ${pct(r.rec)}（${tp}/${truth.size}）` };
});

/* 2b. 名前も LC_FUNCTION_STARTS も無いときの推測（配布アプリの普通の姿） */
feature('funcs-guess', '関数の切れ目を推測する（表なし）', async ({ w, o }) => {
  const res = await w.backend.guessFunctions(w.region.id, 400000);
  const list = res.starts || res.addrs || [];
  const truth = new Set(o.functionStarts);
  let tp = 0, fp = 0;
  for (const a of list) { if (truth.has(Number(a))) tp++; else fp++; }
  const r = f1(tp, fp, truth.size - tp);
  return { score: r.f1, detail: `適合 ${pct(r.prec)} / 再現 ${pct(r.rec)}（${tp}/${truth.size}）` };
});

/* 3. 逆アセンブル（命令の文字そのもの） */
feature('disasm', '命令を逆アセンブルする', async ({ w, o }) => {
  const samples = stride(o.sampleInsns, 4000);
  const vm = Number(w.region.vmAddr);
  const byChunk = new Map();
  for (const s of samples) {
    const row = (s[0] - vm) / 4;
    const c = Math.floor(row / 1024);
    if (!byChunk.has(c)) byChunk.set(c, []);
    byChunk.get(c).push([row % 1024, s[1], s[2]]);
  }
  let hit = 0, miss = 0;
  const bad = [];
  for (const [c, list] of byChunk) {
    const res = await w.backend.fetchChunk(w.region.id, c, true);
    if (!res.mn) { miss += list.length; continue; }
    for (const [i, mn, ops] of list) {
      const gotMn = (res.mn[i] || '').trim();
      const gotOps = (res.ops[i] || '').trim();
      if (gotMn === mn && normOps(gotOps) === normOps(ops)) hit++;
      else { miss++; if (bad.length < 5) bad.push(`${mn} ${ops} → ${gotMn} ${gotOps}`); }
    }
  }
  return { score: hit / (hit + miss), detail: `${hit}/${hit + miss}` + (bad.length ? ' 例: ' + bad[0] : '') };
});
function normOps(s) { return String(s).replace(/\s+/g, ' ').replace(/#0x0$/, '#0').trim(); }

/* 4. 命令の意味づけ（Capstone を通さない語の分類） */
const MN_TO_KIND = {
  nop: 'NOP', hint: 'NOP', bti: 'NOP', pacibsp: 'NOP', autibsp: 'NOP', paciasp: 'NOP', autiasp: 'NOP',
  adrp: 'ADRP', adr: 'ADRP',
  movz: 'MOVIMM', movn: 'MOVIMM', movk: 'MOVIMM',
  mov: null, // 定数か複製かは op で決まる。下で判定する。
  add: 'ARITH', sub: 'ARITH', adds: 'ARITH', subs: 'ARITH', neg: 'ARITH', negs: 'ARITH',
  madd: 'MUL', msub: 'MUL', mul: 'MUL', smull: 'MUL', umull: 'MUL', smulh: 'MUL', umulh: 'MUL',
  mneg: 'MUL', smaddl: 'MUL', umaddl: 'MUL', smsubl: 'MUL', umsubl: 'MUL',
  sdiv: 'DIV', udiv: 'DIV',
  and: 'LOGIC', orr: 'LOGIC', eor: 'LOGIC', ands: 'LOGIC', bic: 'LOGIC', orn: 'LOGIC', eon: 'LOGIC',
  bics: 'LOGIC', mvn: 'LOGIC',
  lsl: 'SHIFT', lsr: 'SHIFT', asr: 'SHIFT', ror: 'SHIFT', ubfm: 'SHIFT', sbfm: 'SHIFT', bfm: 'SHIFT',
  ubfx: 'SHIFT', sbfx: 'SHIFT', bfi: 'SHIFT', bfxil: 'SHIFT', ubfiz: 'SHIFT', sbfiz: 'SHIFT',
  extr: 'SHIFT', rev: 'SHIFT', rev16: 'SHIFT', rev32: 'SHIFT', clz: 'SHIFT', rbit: 'SHIFT',
  sxtw: 'SHIFT', sxtb: 'SHIFT', sxth: 'SHIFT', uxtb: 'SHIFT', uxth: 'SHIFT',
  fadd: 'FARITH', fsub: 'FARITH', fabs: 'FARITH', fneg: 'FARITH', fsqrt: 'FARITH',
  fmul: 'FMUL', fdiv: 'FMUL', fmadd: 'FMUL', fmsub: 'FMUL', fnmul: 'FMUL', fnmadd: 'FMUL',
  scvtf: 'FCONV', ucvtf: 'FCONV', fcvtzs: 'FCONV', fcvtzu: 'FCONV', fcvt: 'FCONV',
  fcvtas: 'FCONV', fcvtau: 'FCONV', fcvtms: 'FCONV', fcvtps: 'FCONV', fcvtns: 'FCONV',
  ldr: 'LOAD', ldrb: 'LOAD', ldrh: 'LOAD', ldrsb: 'LOAD', ldrsh: 'LOAD', ldrsw: 'LOAD',
  ldur: 'LOAD', ldurb: 'LOAD', ldurh: 'LOAD', ldursb: 'LOAD', ldursh: 'LOAD', ldursw: 'LOAD',
  ldp: 'LOAD', ldnp: 'LOAD', ldpsw: 'LOAD',
  str: 'STORE', strb: 'STORE', strh: 'STORE', stur: 'STORE', sturb: 'STORE', sturh: 'STORE',
  stp: 'STORE', stnp: 'STORE',
  cmp: 'CMP', cmn: 'CMP', tst: 'CMP', fcmp: 'CMP', fcmpe: 'CMP', ccmp: 'CMP', ccmn: 'CMP',
  cbz: 'CONDBR', cbnz: 'CONDBR', tbz: 'CONDBR', tbnz: 'CONDBR',
  b: 'BRANCH', br: 'BRANCH', braa: 'BRANCH', brab: 'BRANCH',
  bl: 'CALL', blr: 'INDCALL', blraa: 'INDCALL', blrab: 'INDCALL',
  ret: 'RET', retab: 'RET', retaa: 'RET',
  csel: 'CSEL', csinc: 'CSEL', csinv: 'CSEL', csneg: 'CSEL', cset: 'CSEL', csetm: 'CSEL',
  cinc: 'CSEL', cinv: 'CSEL', cneg: 'CSEL', fcsel: 'CSEL',
  ldxr: 'ATOMIC', stxr: 'ATOMIC', ldaxr: 'ATOMIC', stlxr: 'ATOMIC', ldar: 'ATOMIC', stlr: 'ATOMIC',
  ldadd: 'ATOMIC', ldaddal: 'ATOMIC', cas: 'ATOMIC', casal: 'ATOMIC', swpal: 'ATOMIC',
  dmb: 'SYS', dsb: 'SYS', isb: 'SYS', mrs: 'SYS', msr: 'SYS', svc: 'SYS', sys: 'SYS',
  brk: 'TRAP', udf: 'TRAP',
};
function expectedKind(mn, ops) {
  // まとめて計算する形（v0.8b など）は SIMD。対応表は整数の綴りを持っている。
  if (/\bv\d+\.\d*[bhsdq]/.test(ops)) return null;
  if (mn.startsWith('b.')) return 'CONDBR';
  if (mn === 'mov') return /#/.test(ops) ? 'MOVIMM' : 'MOVREG';
  const k = MN_TO_KIND[mn];
  if (k) return k;
  return null;                              // SIMD など、対応表に無いものは採点しない
}

feature('kinds', '命令の種類を見分ける', async ({ w, o }) => {
  const KIND = (await import('../js/program.js')).KIND;
  const NAME = Object.keys(KIND);
  const vm = Number(w.region.vmAddr);
  let hit = 0, wrong = 0, other = 0, judged = 0;
  const confus = new Map();
  for (const [addr, mn, ops] of o.sampleInsns) {
    const want = expectedKind(mn, ops);
    if (!want) continue;
    const row = (addr - vm) / 4;
    if (row < 0 || row >= w.scan.kindsCovered) continue;
    judged++;
    const got = NAME[w.scan.kinds[row]];
    if (got === want) hit++;
    else if (got === 'OTHER') other++;
    else {
      wrong++;
      const k = mn + ' → ' + got;
      confus.set(k, (confus.get(k) || 0) + 1);
    }
  }
  const top = [...confus.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, n]) => `${k}×${n}`).join(', ');
  return {
    score: hit / judged,
    detail: `${hit}/${judged}（未分類 ${other}, 誤り ${wrong}）${top ? ' ' + top : ''}`,
  };
});

/* 5. 呼び出しの辺 */
feature('calls', '呼び出し関係をたどる', async ({ w, o }) => {
  const truth = new Set(o.calls.map(([a, b]) => a + ':' + b));
  let tp = 0, fp = 0;
  const cf = w.scan.callFrom, ct = w.scan.callTo;
  for (let i = 0; i < cf.length; i++) {
    if (truth.has(Number(cf[i]) + ':' + Number(ct[i]))) tp++; else fp++;
  }
  const r = f1(tp, fp, truth.size - tp);
  return { score: r.f1, detail: `適合 ${pct(r.prec)} / 再現 ${pct(r.rec)}（${tp}/${truth.size}）` };
});

/* 6. データ参照（adrp+add / adrp+ldr の行き先） */
feature('refs', 'データの参照先を解く', async ({ w, o }) => {
  const truth = new Map();
  for (const k of Object.keys(o.adrTargets)) truth.set(Number(k), o.adrTargets[k]);
  let tp = 0, fp = 0;
  const rf = w.scan.refFrom, rt = w.scan.refTo;
  const seen = new Set();
  for (let i = 0; i < rf.length; i++) {
    const a = Number(rf[i]);
    if (!truth.has(a)) continue;            // ldr literal など、正解表に無い種類は採点しない
    seen.add(a);
    if (truth.get(a) === Number(rt[i])) tp++; else fp++;
  }
  const fn = truth.size - seen.size;
  const r = f1(tp, fp, fn);
  return { score: r.f1, detail: `適合 ${pct(r.prec)} / 再現 ${pct(r.rec)}（${tp}/${truth.size}）` };
});

/* 7. 外部 API の名前（__stubs） */
feature('imports', '外部 API の名前を出す', async ({ w, o }) => {
  const keys = Object.keys(o.stubs);
  let hit = 0, wrong = 0, none = 0;
  for (const k of keys) {
    const got = w.symbols.nameAt(BigInt(k));
    if (!got) none++;
    else if (got.replace(/^_/, '') === o.stubs[k].replace(/^_/, '')) hit++;
    else wrong++;
  }
  return { score: hit / keys.length, detail: `${hit}/${keys.length}（無名 ${none}, 誤り ${wrong}）` };
});

/* 8. Objective-C のクラス表 */
feature('objc', 'クラスとフィールドの表を読む', async ({ w, o }) => {
  const got = new Map();
  for (const c of (w.objcModel ? w.objcModel.classes : [])) got.set(c.name, c);
  let cHit = 0;
  let ivWant = 0, ivHit = 0, mWant = 0, mHit = 0;
  for (const c of o.objcClasses) {
    const g = got.get(c.name);
    if (!g) { ivWant += c.ivars.length; mWant += c.methods.length; continue; }
    cHit++;
    const gi = new Map((g.ivars || []).map((i) => [i.name, i]));
    for (const iv of c.ivars) {
      ivWant++;
      const h = gi.get(iv.name);
      if (h && Number(h.offset) === iv.offset) ivHit++;
    }
    const gm = new Map();
    for (const m of (g.methods || []).concat(g.classMethods || [])) gm.set(m.sel, m);
    for (const m of c.methods) {
      mWant++;
      const h = gm.get(m.name);
      if (h && Number(h.addr) === m.addr) mHit++;
    }
  }
  const score = (cHit / o.objcClasses.length + ivHit / ivWant + mHit / mWant) / 3;
  return {
    score,
    detail: `クラス ${cHit}/${o.objcClasses.length}, 変数 ${ivHit}/${ivWant}, メソッド ${mHit}/${mWant}`,
  };
});

/* 9. objc_msgSend$sel の中継地点 → セレクタ名 */
feature('selstub', 'メソッド呼び出しの相手を名指しする', async ({ w, o }) => {
  const keys = Object.keys(o.objcStubs);
  let hit = 0, none = 0, wrong = 0;
  for (const k of keys) {
    const got = w.symbols.nameAt(BigInt(k));
    if (!got) none++;
    else if (got.includes(o.objcStubs[k])) hit++;
    else wrong++;
  }
  return { score: hit / keys.length, detail: `${hit}/${keys.length}（無名 ${none}, 誤り ${wrong}）` };
});

/* 10. 文字列 */
feature('strings', '文字列を集める', async ({ w, o }) => {
  const got = new Set(w.strings.map((s) => Number(s.addr)));
  const want = Object.keys(o.strings).filter((k) => o.strings[k].length >= 4);
  let hit = 0;
  for (const k of want) if (got.has(Number(k))) hit++;
  return { score: hit / want.length, detail: `${hit}/${want.length}` };
});

/* 11. 文字列を使っている場所 */
feature('xrefs', '文字列の参照元をたどる', async ({ w, o }) => {
  const keys = stride(Object.keys(o.stringXrefs), 800);
  let tp = 0, fp = 0, fn = 0;
  for (const k of keys) {
    const want = new Set(o.stringXrefs[k]);
    const sites = w.program.refSitesTo(BigInt(k), 1n, 4000);
    const got = new Set(sites.map((s) => Number(s.site)));
    for (const g of got) { if (want.has(g)) tp++; else fp++; }
    for (const x of want) if (!got.has(x)) fn++;
  }
  const r = f1(tp, fp, fn);
  return { score: r.f1, detail: `適合 ${pct(r.prec)} / 再現 ${pct(r.rec)}（標本 ${keys.length} 本）` };
});

/* 12. 関数の名前を取り戻す（ObjC メソッド） */
feature('funcname', '関数の本当の名前を取り戻す', async ({ w, o }) => {
  const all = [];
  for (const c of o.objcClasses) for (const m of c.methods) all.push([m.addr, c.name, m.name]);
  const samples = stride(all, 6000);
  let hit = 0, partial = 0, none = 0;
  for (const [addr, cls, sel] of samples) {
    const owner = w.fields.ownerOf(BigInt(addr));
    const name = w.symbols.nameAt(BigInt(addr));
    const text = (owner ? owner.className + ' ' + owner.sel : '') + ' ' + (name || '');
    if (text.includes(cls) && text.includes(sel)) hit++;
    else if (text.includes(cls) || text.includes(sel)) partial++;
    else none++;
  }
  return { score: hit / samples.length, detail: `${hit}/${samples.length}（片方だけ ${partial}, 無名 ${none}）` };
});

/* 13. self のフィールドを名前で読む */
feature('selffield', 'x0+0x20 をフィールド名で読む', async ({ w, o }) => {
  const layout = new Map();          // class -> Map(offset -> name)
  for (const c of o.objcClasses) {
    const m = new Map();
    for (const iv of c.ivars) if (iv.offset != null) m.set(iv.offset, iv.name);
    if (m.size) layout.set(c.name, m);
  }
  let hit = 0, want = 0;
  for (const [cls, m] of layout) {
    for (const [off, name] of m) {
      want++;
      const r = w.fields.fieldAt(cls, off);
      if (r && r.exact && r.field.name === name) hit++;
    }
  }
  return { score: hit / want, detail: `${hit}/${want}` };
});

/**
 * 関数 1 本の役割を、画面と同じ手順で出す（auto.js の deep とそろえてある）。
 * ここがずれると、測っているのは画面が出す答えではなくなる。
 */
async function roleAt(w, addr) {
  const { inferRole } = await import('../js/role.js');
  const { findValueUpdates, constantComparisons } = await import('../js/dataflow.js');
  const range = w.program.functionRange(addr);
  const model = await w.analyze(addr, range ? range.end : null);
  if (!model) return null;
  const updates = findValueUpdates(model)
    .filter((u) => u.kind !== 'compute-store');
  const owner = w.fields.ownerOf(addr);
  for (const u of updates) {
    u.field = w.fields.resolveAccess({
      base: u.location.base, disp: u.location.disp,
      indexAddr: u.location.indexAddr, self: u.location.self,
    }, owner ? owner.className : null);
  }
  const f = model.facts || {};
  return inferRole({
    name: w.symbols.nameAt(addr),
    owner,
    updates,
    apis: f.apis || [],
    selectors: (model.calls || []).map((c) => c.selector).filter(Boolean),
    strings: (f.strings || []).map((text) => ({ text })),
    callees: f.calledNames || [],
    callers: [],
    comparisons: constantComparisons(model).length,
    conditionals: f.conditionals || 0,
    calls: f.calls || 0,
    stores: f.stores || 0,
    verified: true,
  });
}

/* 14. アクセサの役割（読み出し／書き込み）を命令から言い当てる */
feature('role', 'この関数が何をしているかを言う', async ({ w, o }) => {
  const cases = [];
  for (const c of o.objcClasses) {
    const ivNames = new Set(c.ivars.map((i) => (i.name || '').replace(/^_+/, '').toLowerCase()));
    for (const m of c.methods) {
      const sel = m.name;
      if (/^set[A-Z]\w*:$/.test(sel)) {
        const f = sel.slice(3, -1);
        if (ivNames.has(f.toLowerCase())) cases.push([m.addr, c.name, f, 'write']);
      } else if (/^[a-z]\w*$/.test(sel) && ivNames.has(sel.toLowerCase())) {
        cases.push([m.addr, c.name, sel, 'read']);
      }
    }
  }
  const samples = stride(cases, 300);
  let hit = 0;
  const miss = [];
  for (const [addr, cls, field, want] of samples) {
    const r = await roleAt(w, BigInt(addr));
    const act = r && r.action;
    const subj = r && r.subject && (r.subject.name || r.subject.plain || '');
    const okAct = want === 'write' ? (act === 'set' || act === 'clear') : act === 'get';
    const okSubj = String(subj).replace(/^_+/, '').toLowerCase() === field.toLowerCase();
    if (okAct && okSubj) hit++;
    else if (miss.length < 3) miss.push(`${cls}.${field}(${want}) → ${act}/${subj}`);
  }
  return {
    score: hit / samples.length,
    detail: `${hit}/${samples.length}` + (miss.length ? ' 例: ' + miss[0] : ''),
  };
}, { slow: true });

/* 15. 目的から値を 1 個に決める */
feature('pinpoint', '目的から場所を 1 個に決める', async ({ w, o }) => {
  const { pinpointField } = await import('../js/pinpoint.js');
  const { parseGoal } = await import('../js/goals.js');
  // 名前がバイナリ中で一意な変数だけを問題にする（一意でないものは正解が定義できない）
  const count = new Map();
  const owner = new Map();
  for (const c of o.objcClasses) {
    for (const iv of c.ivars) {
      const n = (iv.name || '').replace(/^_+/, '');
      if (n.length < 4) continue;
      count.set(n, (count.get(n) || 0) + 1);
      owner.set(n, [c.name, iv.name]);
    }
  }
  const unique = [...count.entries()].filter(([, n]) => n === 1).map(([n]) => n);
  const samples = stride(unique.sort(), 40);
  let hit = 0, decided = 0;
  const miss = [];
  for (const n of samples) {
    const [cls, ivName] = owner.get(n);
    const goal = parseGoal(n);
    if (!goal) continue;
    const res = await pinpointField({
      goal, fields: w.fields, program: w.program, symbols: w.symbols,
      strings: w.strings, analyze: w.analyze, scanAccess: w.scanAccess,
    });
    const top = res && res.top;
    if (!top) { if (miss.length < 3) miss.push(n + ' → 決まらず'); continue; }
    decided++;
    if (top.className === cls && (top.field && top.field.name) === ivName) hit++;
    else if (miss.length < 3) miss.push(`${n} → ${top.className}.${top.field && top.field.name}`);
  }
  return {
    score: hit / samples.length,
    detail: `${hit}/${samples.length} 正解（決着 ${decided}）` + (miss.length ? ' 例: ' + miss[0] : ''),
  };
}, { slow: true });

/* 15b. うろ覚えの名前で探す（名前の一部しか覚えていない、いちばん普通の使い方） */
feature('pinpoint-partial', 'うろ覚えの名前から場所を決める', async ({ w, o }) => {
  const { pinpointField } = await import('../js/pinpoint.js');
  const { parseGoal, normalizeFieldName } = await import('../js/goals.js');
  /*
   * 「_adShowTime」を「show time」と打つ。丸ごと一致の近道は使えないので、
   * ここが本当の意味での「1 個に決められるか」になる。
   * 答えが 1 つに決まる問いだけを出す（後半 2 語が全体で 1 か所しかないもの）。
   */
  const all = [];                      // [正規化した名前, クラス, ivar 名]
  const tails = new Map();
  for (const c of o.objcClasses) {
    for (const iv of c.ivars) {
      const norm = normalizeFieldName(iv.name);
      all.push([' ' + norm + ' ', c.name, iv.name]);
      const words = norm.split(' ').filter((x) => x.length >= 3);
      if (words.length < 3) continue;
      const tail = words.slice(-2).join(' ');
      if (!tails.has(tail)) tails.set(tail, [c.name, iv.name]);
    }
  }
  /*
   * 答えが 1 つに決まる問いだけを出す。
   * 「deduplication ids」が 2 つの変数名に入っているなら、どちらを出しても
   * 間違いとは言えない。そういう問いで測っても、精度を測ったことにならない。
   */
  const owner = new Map();
  const unique = [];
  for (const [tail, who] of tails) {
    const needle = ' ' + tail + ' ';
    let n = 0;
    for (const [norm] of all) { if (norm.includes(needle) && ++n > 1) break; }
    if (n === 1) { unique.push(tail); owner.set(tail, who); }
  }
  unique.sort();
  const samples = stride(unique, 40);
  let hit = 0, decided = 0;
  const miss = [];
  for (const tail of samples) {
    const [cls, ivName] = owner.get(tail);
    const goal = parseGoal(tail);
    const res = await pinpointField({
      goal, fields: w.fields, program: w.program, symbols: w.symbols,
      strings: w.strings, analyze: w.analyze, scanAccess: w.scanAccess,
    });
    const top = res && res.top;
    if (!top) { if (miss.length < 3) miss.push(tail + ' → 決まらず'); continue; }
    decided++;
    if (top.className === cls && top.field && top.field.name === ivName) hit++;
    else if (miss.length < 3) miss.push(`${tail} → ${top.className}.${top.field && top.field.name}`);
  }
  return {
    score: hit / samples.length,
    detail: `${hit}/${samples.length} 正解（決着 ${decided}）` + (miss.length ? ' 例: ' + miss[0] : ''),
  };
}, { slow: true });

/* 16. 呼んでいる外部 API に意味が付くか */
feature('apimeaning', '呼んでいる API の意味を言う', async ({ w, o }) => {
  const { apiInfo } = await import('../js/blocks.js');
  // 実際に呼ばれている回数で重みづけ（使われない API に意味を付けても意味がない）
  const stubUse = new Map();
  const ct = w.scan.callTo;
  for (let i = 0; i < ct.length; i++) {
    const t = Number(ct[i]);
    if (o.stubs[t] || o.objcStubs[t]) stubUse.set(t, (stubUse.get(t) || 0) + 1);
  }
  let known = 0, total = 0;
  const unknown = new Map();
  for (const [addr, n] of stubUse) {
    total += n;
    const name = o.stubs[addr] || ('objc_msgSend$' + o.objcStubs[addr]);
    if (apiInfo(name)) known += n;
    else unknown.set(name, (unknown.get(name) || 0) + n);
  }
  const top = [...unknown.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, n]) => `${k}×${n}`).join(', ');
  return { score: total ? known / total : 0, detail: `呼び出し ${known}/${total} 件に意味付き` + (top ? ' 未知: ' + top : '') };
});

/* 17. 関数の要約が、実際に呼んでいるものを言えているか */
feature('summary', '関数の要約が中身と合っている', async ({ w, o }) => {
  const { functionStory, apiShort } = await import('../js/narrate.js');
  const { apiInfo } = await import('../js/blocks.js');
  const named = [];
  for (const c of o.objcClasses) for (const m of c.methods) named.push(m.addr);
  /*
   * 何を「言えていたら正解」とするか。
   *
   * ARC や Swift ランタイムの下働き（objc_release / swift_beginAccess …）は
   * どの関数にも入っていて、その関数が何をしているかを何ひとつ言っていない。
   * それを 1 つずつ読み上げる要約は、良い要約ではない。だから採点の対象は
   * 「人が名前を付けた呼び先」— セレクタと、ふつうのライブラリ関数だけにする。
   */
  const PLUMBING = /^_+(objc_(retain|release|autorelease|storeStrong|storeWeak|loadWeak|destroyWeak|initWeak|copyWeak|moveWeak|sync_|enumerationMutation|begin_catch|end_catch|opt_|msgSend$|exception)|swift_|_?cxa_|Block_|Unwind_|Z[dn]|stack_chk|dyld)/;
  const callsBySrc = new Map();
  for (const [src, dst] of o.calls) {
    const name = o.stubs[dst] || (o.objcStubs[dst] ? 'objc:' + o.objcStubs[dst] : null);
    if (!name || PLUMBING.test(name)) continue;
    callsBySrc.set(src, name);
  }
  const starts = o.functionStarts;
  const idx = new Map();
  for (let i = 0; i < starts.length; i++) idx.set(starts[i], i);
  const withApi = named.filter((a) => idx.has(a)).filter((a) => {
    const i = idx.get(a);
    const end = starts[i + 1] || a + 64;
    for (let p = a; p < end; p += 4) if (callsBySrc.has(p)) return true;
    return false;
  });
  const samples = stride(withApi, 200);
  let hit = 0, n = 0;
  for (const a of samples) {
    const i = idx.get(a);
    const end = starts[i + 1] || a + 256;
    const want = new Set();
    for (let p = a; p < end; p += 4) if (callsBySrc.has(p)) want.add(callsBySrc.get(p));
    const model = await w.analyze(BigInt(a), BigInt(end));
    if (!model) continue;
    n++;
    const story = functionStory(model, w.symbols.nameAt(BigInt(a))) || [];
    const text = JSON.stringify(story);
    let ok = 0;
    for (const nm of want) {
      const core = nm.replace(/^objc:/, '').replace(/^_+/, '').replace(/:.*$/, '');
      if (core.length >= 4 && text.includes(core)) { ok++; continue; }
      /*
       * 綴りをそのまま出さず、日本語で言い換えていることもある
       * （`_objc_alloc` →「新しいものを作る」）。それは名指しできている。
       */
      const info = apiInfo(nm.replace(/^objc:/, ''));
      const phrase = info ? apiShort(info.id) : null;
      if (phrase && text.includes(phrase)) ok++;
    }
    /*
     * 合格の線。
     *
     * 呼び先が 3 本なら半分は名指しできるべきだが、45 本呼んでいる関数で
     * 45 本すべてを読み上げる要約は、良い要約ではない（誰も読めない）。
     * だから「半分、ただし 5 本名指しできていれば十分」とする。
     */
    if (ok >= Math.min(5, Math.ceil(want.size / 2))) hit++;
  }
  return { score: n ? hit / n : 0, detail: `${hit}/${n} の要約が呼び先をきちんと名指し` };
}, { slow: true });

/* 20. 命令をまたいだ計算を、1 つの式に戻す */
feature('expr', '割り算に戻す（魔法数の逆算）', async ({ w, o }) => {
  const { buildValues, walk } = await import('../js/expr.js');
  /*
   * 割り算は掛け算に置き換えられて出てくる。逆算できているかは、
   * 「置き換えの形が命令として実在する関数」を集めて、そのうち何本で
   * 割り算に戻せたかで測る。正解表は要らない —
   * 元が割り算だったことは、魔法数とずらし幅から算数として確かめられる。
   */
  const starts = o.functionStarts;
  const cands = [];
  for (let i = 0; i < starts.length - 1 && cands.length < 4000; i++) {
    cands.push([starts[i], starts[i + 1]]);
  }
  const samples = stride(cands, 900);
  let withIdiom = 0, recovered = 0;
  const miss = [];
  for (const [a, end] of samples) {
    if (end - a > 4096) continue;
    const model = await w.analyze(BigInt(a), BigInt(end));
    if (!model) continue;
    /* 置き換えの形: 上位を取る掛け算（smulh/umulh/smull/umull）＋ 符号直しの lsr #63 */
    const insns = model.instructions || [];
    const hasHigh = insns.some((i) => /^(smulh|umulh|smull|umull)$/i.test(i.mnemonic || ''));
    const hasFix = insns.some((i) => /^(lsr|asr)$/i.test(i.mnemonic || '') &&
      /#0x3f|#63|#0x1f|#31/.test(i.operands || ''));
    if (!hasHigh || !hasFix) continue;
    withIdiom++;
    let ok = false;
    const vg = buildValues(model, {});
    for (const [, made] of vg.defs) {
      for (const reg of Object.keys(made)) {
        walk(made[reg], (n) => {
          if (n.k === 'bin' && (n.op === 'sdiv' || n.op === 'udiv') &&
              n.b && n.b.k === 'const' && n.b.v > 2n) ok = true;
        });
      }
      if (ok) break;
    }
    if (ok) recovered++;
    else if (miss.length < 3) miss.push('0x' + a.toString(16));
  }
  return {
    score: withIdiom ? recovered / withIdiom : 0,
    detail: `${recovered}/${withIdiom} 本で割り算に戻せた` + (miss.length ? ' 例: ' + miss[0] : ''),
  };
}, { slow: true });

/* 21. 開発者が書いた計算式と、復元した計算式が合う */
feature('formula', '書かれた計算式と復元した式が合う', async ({ w, o }) => {
  const { comprehend, formulaOf } = await import('../js/comprehend.js');
  /*
   * このツールの「確定」の土台。文言に計算式が書いてある関数を集めて、
   * 命令から戻した式がその数と一致するかを測る。
   * 一致しない＝式に戻せていない、なので、ここは復元力そのものの物差しになる。
   */
  const formulaStrings = (w.strings || []).filter((s) => formulaOf(s.text));
  const users = new Map();
  for (const s of formulaStrings.slice(0, 600)) {
    for (const u of w.program.functionsReferencing(s.addr, 1n, 8)) {
      if (u.addr == null) continue;
      const fn = w.program.functionRange(u.addr);
      if (fn) users.set(fn.start.toString(), fn);
    }
  }
  const samples = stride(Array.from(users.values()), 60);
  /*
   * 点は「文言が名乗っている数のうち、何割を命令の側でも見つけられたか」。
   * 当たり外れの 2 値ではなく割合にするのは、式が半分だけ戻せている状態が
   * 実際にあるため（そこが伸びたことを見えるようにしたい）。
   */
  let sum = 0, n = 0;
  const miss = [];
  for (const fn of samples) {
    const model = await w.analyze(fn.start, fn.end);
    if (!model) continue;
    /*
     * 文言を「持っている」だけの関数（表の初期化など）は数えない。
     * 測りたいのは、書かれた計算を **している** 関数で式に戻せるかどうか。
     */
    const doesMath = (model.instructions || []).some((i) =>
      /^(mul|madd|msub|sdiv|udiv|smull|umull|smulh|umulh|smaddl|umaddl|fmul|fdiv)$/i.test(i.mnemonic || ''));
    if (!doesMath) continue;
    n++;
    const c = comprehend({ model, symbolFor: (x) => w.symbols.nameAt(x) });
    const ratio = c && c.formula ? c.formula.matched / c.formula.claimed : 0;
    sum += ratio;
    if (ratio < 0.5 && miss.length < 3) miss.push('0x' + fn.start.toString(16));
  }
  void o;
  return {
    score: n ? sum / n : 0,
    detail: `${n} 本の平均一致率` + (miss.length ? '（弱い例: ' + miss[0] + '）' : ''),
  };
}, { slow: true });

/* 22. 逆コンパイル結果に「訳せなかった命令」が残っていないか */
feature('pseudoc', '逆コンパイルで訳せない命令が残らない', async ({ w, o }) => {
  const { decompile } = await import('../js/decompile.js');
  const starts = o.functionStarts;
  const cands = [];
  for (let i = 0; i < starts.length - 1; i++) {
    if (starts[i + 1] - starts[i] >= 64 && starts[i + 1] - starts[i] <= 2048) {
      cands.push([starts[i], starts[i + 1]]);
    }
  }
  const samples = stride(cands, 120);
  let lines = 0, asmLines = 0, done = 0;
  for (const [a, end] of samples) {
    const model = await w.analyze(BigInt(a), BigInt(end));
    if (!model) continue;
    let res;
    try {
      res = decompile(model, {
        addr: BigInt(a),
        rowOfAddress: (x) => (x == null ? null : Number((x - w.region.vmAddr) / 4n)),
        addrOfRow: (r) => w.region.vmAddr + BigInt(r) * 4n,
        symbolFor: (x) => w.symbols.nameAt(x),
      });
    } catch { continue; }
    done++;
    for (const l of res.lines) {
      if (l.kind !== 'stmt' && l.kind !== 'ctrl') continue;
      lines++;
      if (/__asm\(/.test(l.text)) asmLines++;
    }
  }
  return {
    score: lines ? 1 - asmLines / lines : 0,
    detail: `${lines - asmLines}/${lines} 行が C の式になった（関数 ${done} 本）`,
  };
}, { slow: true });

/* ── 実行 ───────────────────────────────────────────────────── */

async function main() {
  const oraclePath = path.resolve(ROOT, ORACLE);
  if (!fs.existsSync(oraclePath)) {
    console.error('正解表がありません: ' + ORACLE +
      '\n  python3 tests/oracle.py ' + TARGET + ' ' + ORACLE);
    process.exit(2);
  }
  process.stderr.write('正解表を読み込み中…\n');
  const o = JSON.parse(zlib.gunzipSync(fs.readFileSync(oraclePath)).toString('utf8'));
  process.stderr.write('バイナリを解析中…\n');
  const t0 = Date.now();
  const w = await openBinary(TARGET, { log: (m) => process.stderr.write('  ' + m + '\n') });
  process.stderr.write('  ' + ((Date.now() - t0) / 1000).toFixed(1) + 's\n\n');

  const rows = [];
  for (const f of FEATURES) {
    if (ONLY.length && !ONLY.includes(f.id)) continue;
    const t = Date.now();
    let r;
    try {
      r = await f.fn({ w, o });
    } catch (err) {
      r = { score: 0, detail: 'エラー: ' + err.message };
      if (flag('trace')) console.error(err);
    }
    r.id = f.id; r.label = f.label; r.ms = Date.now() - t;
    rows.push(r);
    if (!flag('json')) {
      process.stdout.write(
        pad(pct(r.score), 7) + '  ' + pad(f.label, 34) + '  ' + (r.detail || '') + '\n');
    }
  }

  const base = opt('base', null);
  if (base && fs.existsSync(path.resolve(ROOT, base))) {
    const prev = JSON.parse(fs.readFileSync(path.resolve(ROOT, base), 'utf8'));
    const byId = new Map(prev.map((r) => [r.id, r]));
    console.log('\n── 前回との差 ──');
    for (const r of rows) {
      const p = byId.get(r.id);
      if (!p) continue;
      const d = r.score - p.score;
      if (Math.abs(d) < 0.001) continue;
      console.log(`  ${d > 0 ? '+' : ''}${(d * 100).toFixed(1)}pt  ${r.label}  (${pct(p.score)} → ${pct(r.score)})`);
    }
  }

  const save = opt('save', null);
  if (save) fs.writeFileSync(path.resolve(ROOT, save), JSON.stringify(rows, null, 2));

  if (flag('json')) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    const over50 = rows.filter((r) => r.score >= 0.5).length;
    const over90 = rows.filter((r) => r.score >= 0.9).length;
    console.log('\n  ' + rows.length + ' 機能中、50% 超え ' + over50 + ' / 90% 超え ' + over90);
  }
  process.exit(0);
}

function pad(s, n) {
  s = String(s);
  const width = [...s].reduce((a, ch) => a + (/[　-鿿＀-￯]/.test(ch) ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - width));
}

main();
