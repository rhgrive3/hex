/*
 * 外とのつながり — インポート・エクスポート・ライブラリ・グローバル変数。
 *
 * アプリの実行ファイルは、それ単体では動きません。画面を出すのも、通信するのも、
 * 暗号を計算するのも、iOS が用意したライブラリ（framework）を呼んで実現しています。
 *
 *   インポート（import）… このアプリが「外から借りている」関数
 *   エクスポート（export）… このアプリが「外へ貸している」名前
 *   ライブラリ（dylib）  … 借りに行く先の一覧（LC_LOAD_DYLIB）
 *
 * 何を借りているかを見るだけで、アプリが何をするものかが半分わかります。
 * 「SecItemAdd を借りている＝パスワードを保管している」といった具合です。
 *
 * グローバル変数（どこからでも触れる置き場）も、ここで扱います。
 */

import { SYM_STUB, SYM_POINTER } from './symbols.js';
import { readableName } from './rtti.js';

/* ── どの framework の関数かを名前から見当づける ────────────
   正確な対応表はバイナリの中になく（LC_LOAD_DYLIB は「借りる先の一覧」で、
   どの関数がどこから来たかまでは書かれていない）、ここは推測です。
   画面でも「推測」と分かるように出します。 */

const FRAMEWORK_HINTS = [
  [/^_?objc_|^_?class_|^_?sel_|^_?method_/, 'libobjc（Objective-C の土台）', 'objc'],
  [/^_?swift_|^_?\$s/, 'libswiftCore（Swift の土台）', 'swift'],
  [/^_?UI[A-Z]/, 'UIKit（画面の部品）', 'ui'],
  [/^_?NS[A-Z]/, 'Foundation（文字列・配列・日付など）', 'foundation'],
  [/^_?CF[A-Z]/, 'CoreFoundation（Foundation の下回り）', 'foundation'],
  [/^_?CG[A-Z]/, 'CoreGraphics（描画）', 'graphics'],
  [/^_?CA[A-Z]/, 'QuartzCore（アニメーション）', 'graphics'],
  [/^_?MTL|^_?GL|^_?gl[A-Z]/, 'Metal / OpenGL（3D 描画）', 'graphics'],
  [/^_?AV[A-Z]|^_?AudioUnit|^_?AudioQueue/, 'AVFoundation（音と動画）', 'media'],
  [/^_?Sec[A-Z]/, 'Security（キーチェーン・証明書）', 'secret'],
  [/^_?CC(Crypt|HmacInit|SHA|MD5|Digest)/, 'CommonCrypto（暗号・ハッシュ）', 'crypto'],
  [/^_?sqlite3_/, 'libsqlite3（データベース）', 'database'],
  [/^_?SK[A-Z]/, 'StoreKit（アプリ内課金）', 'purchase'],
  [/^_?GK[A-Z]/, 'GameKit（ゲームセンター）', 'game'],
  [/^_?CL[A-Z]/, 'CoreLocation（位置情報）', 'location'],
  [/^_?ASIdentifier|^_?AD[A-Z]|^_?ATTracking/, 'AdSupport / AppTrackingTransparency（広告）', 'ads'],
  [/^_?dispatch_|^_?pthread_/, 'libdispatch / pthread（並行処理）', 'concurrency'],
  [/^_?(malloc|free|calloc|realloc|memcpy|memset|strlen|strcmp|printf|open|read|write|close|socket|connect)$/, 'libSystem（C の基本関数）', 'system'],
  [/^_?os_log|^_?NSLog$/, 'os_log（ログ出力）', 'log'],
  [/^_?ptrace$|^_?sysctl$/, 'libSystem（デバッガ検出に使われることがある）', 'antidebug'],
];

/** その名前がどのライブラリのものか（推測）。 */
export function frameworkOf(name) {
  if (!name) return null;
  for (const [re, label, cat] of FRAMEWORK_HINTS) {
    if (re.test(name)) return { label, cat };
  }
  return null;
}

/**
 * このアプリが借りている関数の一覧。
 *
 * __stubs（中継地点）と __got（アドレスの箱）に名前が付いているものが、
 * そのまま「外から借りているもの」です。
 *
 * @param {object} symbols SymbolIndex
 * @param {object} program ProgramIndex（あれば呼ばれた回数も数える）
 */
export function importList(symbols, program, limit = 4000) {
  if (!symbols) return [];
  const cap=Math.max(1,Number(limit)||4000),seen=new Map();
  const add=(name,addr,{stub=false,library=null,source=null,siteKind=null}={})=>{
    if(!name)return;
    let e=seen.get(name);
    if(!e){const fw=frameworkOf(name);e={name,readable:readableName(name),addr:addr??null,stub,framework:library||fw?.label||null,library:library||null,cat:fw?.cat||null,calls:0,source,sites:0};seen.set(name,e);}
    if(library&&!e.library){e.library=library;e.framework=library;}
    if(addr!=null){e.sites++;if(program)e.calls+=program.callCountOf(BigInt(addr));if(stub||e.addr==null){e.addr=BigInt(addr);e.stub=e.stub||stub;}}
    if(siteKind)e.siteKind=siteKind;
  };
  for(const imp of symbols.linkage?.imports||[]){for(const site of imp.sites||[])add(imp.name,site.address,{library:imp.library,source:imp.source,siteKind:site.kind});if(!(imp.sites||[]).length)add(imp.name,null,{library:imp.library,source:imp.source});}
  if(symbols.symbolCount){
    for(const kind of [SYM_STUB,SYM_POINTER])for(const item of symbols.symbolList({kind,max:Math.max(cap,4000)}))add(item.name,item.addr,{stub:kind===SYM_STUB,source:'symbol-index'});
  }
  const out=Array.from(seen.values()).sort((a,b)=>b.calls-a.calls||a.name.localeCompare(b.name)).slice(0,cap);
  const truth=symbols.linkageCompleteness||symbols.linkage?.completeness||null;
  Object.defineProperties(out,{complete:{value:truth?.importsComplete===true&&seen.size<=cap,enumerable:false},completeness:{value:{complete:truth?.importsComplete===true&&seen.size<=cap,reasons:[...(truth?.reasons||[]),...(seen.size>cap?['result-limit']:[])]},enumerable:false},total:{value:seen.size,enumerable:false}});
  return out;
}

/** 借りている先を framework ごとにまとめる（アプリの性格が見える）。 */
export function importsByFramework(imports) {
  const groups = new Map();
  for (const i of imports) {
    const key = i.framework || 'そのほか（対応が分からないもの）';
    if (!groups.has(key)) groups.set(key, { name: key, cat: i.cat, items: [], calls: 0 });
    const g = groups.get(key);
    g.items.push(i);
    g.calls += i.calls;
  }
  return Array.from(groups.values()).sort((a, b) => b.items.length - a.items.length);
}

/**
 * このアプリが外へ公開している名前。
 * ふつうのアプリ本体ではあまり多くありませんが、フレームワーク（.framework）の
 * 中身を開いたときは、ここがそのまま「使える API の一覧」になります。
 */
export function exportList(symbols, limit = 4000) {
  if (!symbols) return [];
  const cap=Math.max(1,Number(limit)||4000),seen=new Map();
  for(const exp of symbols.linkage?.exports||[]){if(!exp?.name)continue;const key=exp.name+'@'+String(exp.address??'reexport');if(seen.has(key))continue;seen.set(key,{addr:exp.address==null||BigInt(exp.address)===0n?null:BigInt(exp.address),name:exp.name,readable:readableName(exp.name),kind:exp.kind||'export',source:exp.source||'canonical-macho',reexport:exp.kind==='reexport',imported:exp.imported||null});}
  if(symbols.symbolCount){for(let i=0;i<symbols.addrs.length;i++){if(symbols.kinds[i]!==0||!symbols.isExported(i))continue;const name=symbols.names[i];if(!name)continue;const key=name+'@'+symbols.addrs[i].toString();if(!seen.has(key))seen.set(key,{addr:symbols.addrs[i],name,readable:readableName(name),kind:'symbol',source:'symbol-index'});}}
  const out=Array.from(seen.values()).slice(0,cap);const truth=symbols.linkageCompleteness||symbols.linkage?.completeness||null;
  Object.defineProperties(out,{complete:{value:truth?.exportsComplete===true&&seen.size<=cap,enumerable:false},completeness:{value:{complete:truth?.exportsComplete===true&&seen.size<=cap,reasons:[...(truth?.reasons||[]),...(seen.size>cap?['result-limit']:[])]},enumerable:false},total:{value:seen.size,enumerable:false}});
  return out;
}

/* ── グローバル変数 ─────────────────────────────────────── */

/**
 * グローバル変数（どこからでも触れる置き場）を探す。
 *
 * 手がかりは 2 つ:
 *   1. データのセクション（__data / __bss / __const）に名前が付いているもの
 *   2. コードから何度も参照されているデータのアドレス
 *
 * 2 のほうは名前がなくても見つかります。「何度も読み書きされている置き場」は
 * たいていアプリの状態そのもの（所持金、ログイン状態、設定）です。
 *
 * @param {object} symbols
 * @param {object} program ProgramIndex
 * @param {Array} regions
 * @param {object} opts {limit, minRefs}
 */
export function findGlobals(symbols, program, regions, opts) {
  const o = opts || {};
  const limit = o.limit || 300;
  const minRefs = o.minRefs || 2;
  const dataRegions = (regions || []).filter((r) =>
    !r.exec && (r.declaredSize ?? r.size ?? 0n) > 0n &&
    /__data|__bss|__common|__const|__cfstring|__objc_(ivar|const|data)/.test(r.section || ''));

  const out = [];
  const seen = new Set();

  /* 1. 名前が付いているもの */
  if (symbols) {
    for (const r of dataRegions) {
      for (const s of symbols.symbolList({ region: r, kind: 0, max: 2000 })) {
        if (seen.has(s.addr.toString())) continue;
        seen.add(s.addr.toString());
        out.push({
          addr: s.addr, name: s.name, readable: readableName(s.name),
          region: r.name, refs: program ? program.refSitesTo(s.addr, 8n, 200).length : 0,
          named: true,
        });
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
  }

  /* 2. よく参照されている名前なしの置き場 */
  if (program && out.length < limit) {
    const hot = hotDataAddresses(program, dataRegions, limit - out.length, minRefs);
    for (const h of hot) {
      if (seen.has(h.addr.toString())) continue;
      seen.add(h.addr.toString());
      out.push({
        addr: h.addr, name: null,
        readable: 'off_' + h.addr.toString(16).toUpperCase(),
        region: h.region, refs: h.refs, named: false,
      });
    }
  }

  out.sort((a, b) => b.refs - a.refs);
  return out;
}

/** データ参照の多いアドレスを正確に数え上げる。 */
function hotDataAddresses(program, dataRegions, limit, minRefs) {
  const counts = new Map();
  // Regions are few; sorting lets us reject most non-data refs without allocating
  // per-reference objects. Unlike the old fixed-phase sampler, every xref counts.
  const ranges = dataRegions
    .map((r) => ({ r, lo: r.vmAddr, hi: r.vmAddr + (r.declaredSize ?? r.size ?? 0n) }))
    .filter((x) => x.hi > x.lo)
    .sort((a, b) => a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0);
  const inData = (addr) => {
    let lo = 0, hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const x = ranges[mid];
      if (addr < x.lo) hi = mid - 1;
      else if (addr >= x.hi) lo = mid + 1;
      else return x.r;
    }
    return null;
  };
  const n = program.refCount || 0;
  for (let i = 0; i < n; i++) {
    const target = program.refTo[i];
    if (target == null) continue;
    const r = inData(target);
    if (!r) continue;
    const key = target.toString();
    const hit = counts.get(key);
    if (hit) hit.refs++;
    else counts.set(key, { addr: target, refs: 1, region: r.name, complete: true });
  }
  return Array.from(counts.values())
    .filter((c) => c.refs >= minRefs)
    .sort((a, b) => b.refs - a.refs || (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0))
    .slice(0, limit);
}
