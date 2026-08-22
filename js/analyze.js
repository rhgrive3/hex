/*
 * 関数まるごとの要約。
 *
 * 命令を 1 行ずつ読む前に、「この関数はだいたい何をするものか」を先に見せる。
 * 初心者がいきなり数百行のアセンブリに突っ込んで挫折するのを防ぐのが目的。
 *
 * 判定はすべて命令の並びからの推測で、証明ではない。断定的な言い方は避ける。
 */
import { CHUNK_ROWS } from './backend.js';
import { parseOperands, isCall, isReturn, categoryOf, referenceTarget } from './arm64.js';
import { pick } from './i18n.js';
import { buildSemanticModel, attachTexts } from './blocks.js';
import { LRU } from './lru.js';

const MAX_INSTRUCTIONS = 40000;
const MAX_MODEL_ROWS = 6000;
const MODEL_TEXTS = 96;
const ARM64_SEMANTIC_ARCHES = new Set(['arm64', 'arm64e', 'arm64_32']);

export function supportsArm64SemanticAnalysis(architecture) {
  return ARM64_SEMANTIC_ARCHES.has(String(architecture || '').toLowerCase());
}
function rowBudget(opts = {}) {
  const raw = Number(opts?.maxRows);
  if (!Number.isFinite(raw)) return MAX_INSTRUCTIONS;
  return Math.max(1, Math.min(MAX_INSTRUCTIONS, Math.floor(raw)));
}

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(reason == null ? 'Analysis cancelled.' : String(reason));
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function isAbort(error, signal) {
  return !!(signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR');
}

async function awaitAbortable(operation, signal) {
  if (!signal) return operation;
  if (signal.aborted) {
    try { operation?.cancel?.(); } catch { /* cancellation reason is authoritative */ }
    throw abortError(signal);
  }
  let settled = false;
  let onAbort = null;
  return new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    onAbort = () => {
      try { operation?.cancel?.(); } catch { /* cancellation reason is authoritative */ }
      finish(reject, abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function destIndex(mn) {
  const b = mn.toLowerCase();
  if (/^(str|stp|stur|strb|strh|sturb|sturh|stnp|st1|st2|st3|st4|stlr)/.test(b)) return -1;
  if (/^(cmp|cmn|tst|ccmp|ccmn|fcmp|b|bl|br|blr|ret|cbz|cbnz|tbz|tbnz|nop|svc|brk|hint|bti|dmb|dsb|isb|prfm|msr)/.test(b)) return -1;
  if (/^b\./.test(b)) return -1;
  return 0;
}

function readRegs(op, into) {
  if (!op) return;
  if (op.k === 'reg' && op.cls === 'gp') into.add(op.num);
  else if (op.k === 'mem') {
    if (op.base && op.base.cls === 'gp') into.add(op.base.num);
    if (op.index && op.index.cls === 'gp') into.add(op.index.num);
  }
}

export async function analyzeFunction(backend, region, startRow, endRow, symbols, onProgress, opts = {}) {
  const signal = opts?.signal || null;
  throwIfAborted(signal);
  const requestedRows = Math.max(0, endRow - startRow + 1);
  const rows = Math.min(requestedRows, rowBudget(opts));
  if (rows <= 0) throw new Error('analysis-range-empty');
  const truncated = requestedRows > rows;
  const end = startRow + rows - 1;

  const res = {
    startRow, endRow: end, truncated,
    startAddr: region.vmAddr + BigInt(startRow) * 4n,
    endAddr: region.vmAddr + BigInt(end) * 4n,
    instructions: 0, dataRows: 0, frameBytes: 0,
    savesLr: false, savesCallee: [], calls: [], indirectCalls: 0,
    loops: [], condBranches: 0, returns: 0, loads: 0, stores: 0,
    stackAccess: 0, argRegs: [], setsReturnValue: false,
    usesFloat: false, usesSimd: false, usesAtomic: false,
    hasPac: false, hasTrap: false, stringRefs: [],
  };

  const written = new Set();
  const argsRead = new Set();
  const calleeSaved = new Set();
  let lastX0Write = -1;
  const rawInsns = [];
  // Set when the row cap actually dropped instructions. The old code relied on
  // overshooting the cap by one so `buildSemanticModel` would notice the excess
  // and set its own `truncated` flag; keeping the bound exact removes that
  // signal, so the fact is recorded here instead of inferred from a length.
  let modelRowsDropped = false;
  const first = Math.floor(startRow / CHUNK_ROWS);
  const last = Math.floor(end / CHUNK_ROWS);
  const pageOf = new Map();

  for (let c = first; c <= last; c++) {
    throwIfAborted(signal);
    const entry = await awaitAbortable(backend.fetchChunk(region.id, c, true, { signal }), signal);
    throwIfAborted(signal);
    const base = c * CHUNK_ROWS;
    const from = Math.max(startRow, base);
    const to = Math.min(end, base + CHUNK_ROWS - 1);
    if (onProgress) onProgress((c - first + 1) / (last - first + 1));

    for (let row = from; row <= to; row++) {
      if ((row & 127) === 0) throwIfAborted(signal);
      const idx = row - base;
      const mn = entry.mn ? (entry.mn[idx] || '') : '';
      const opsStr = entry.ops ? (entry.ops[idx] || '') : '';
      if (!mn) continue;
      const addr = region.vmAddr + BigInt(row) * 4n;
      const b = mn.toLowerCase();
      // `<=` before the push let the array reach MAX_MODEL_ROWS + 1. The bound
      // exists to cap model construction work, so it has to be exact (#1287).
      if (rawInsns.length < MAX_MODEL_ROWS) rawInsns.push({ row, address: addr, mn, ops: opsStr });
      else modelRowsDropped = true;
      if (b.charCodeAt(0) === 46) { res.dataRows++; continue; }
      res.instructions++;

      const ops = parseOperands(opsStr);
      const catg = categoryOf(b);
      if (catg === 'float') res.usesFloat = true;
      if (catg === 'simd') res.usesSimd = true;
      if (catg === 'atomic') res.usesAtomic = true;
      if (/^(paciasp|pacibsp|autiasp|autibsp|retaa|retab)$/.test(b)) res.hasPac = true;
      if (/^(brk|udf)$/.test(b)) res.hasTrap = true;
      if (catg === 'load') res.loads++;
      if (catg === 'store') res.stores++;

      const di = destIndex(mn);
      const destReg = di >= 0 && ops[di]?.k === 'reg' && ops[di]?.cls === 'gp' ? ops[di].num : null;
      const reads = new Set();
      for (let i = 0; i < ops.length; i++) {
        if (i === di && ops[i].k === 'reg') continue;
        readRegs(ops[i], reads);
      }
      for (const op of ops) if (op.k === 'mem') readRegs(op, reads);
      for (const r of reads) if (r <= 7 && !written.has(r)) argsRead.add(r);
      if (destReg != null) {
        written.add(destReg);
        if (destReg === 0) lastX0Write = row;
      }

      if (b === 'sub' && ops[0] && ops[0].cls === 'sp' && ops[2] && ops[2].k === 'imm' && ops[2].value != null) {
        res.frameBytes += Number(ops[2].value);
      }
      if (/^stp?$/.test(b) || b === 'stp' || b === 'str') {
        const mem = ops.find((x) => x.k === 'mem');
        if (mem && mem.base && mem.base.cls === 'sp') {
          res.stackAccess++;
          if (mem.mode === 'pre' && mem.disp && mem.disp.value != null && mem.disp.value < 0n) res.frameBytes += Number(-mem.disp.value);
        }
      }
      if (b === 'ldr' || b === 'ldp' || b === 'ldur') {
        const mem = ops.find((x) => x.k === 'mem');
        if (mem && mem.base && mem.base.cls === 'sp') res.stackAccess++;
      }
      for (const op of ops) {
        if (op.k === 'reg' && op.cls === 'gp') {
          if (op.num === 30 && /^st/.test(b)) res.savesLr = true;
          if (op.num >= 19 && op.num <= 28 && /^st/.test(b)) calleeSaved.add(op.num);
        }
      }

      if (isCall(b)) {
        if (b === 'bl') {
          const t = referenceTarget(b, opsStr);
          res.calls.push({ row, addr, target: t, name: t != null && symbols ? symbols.nameAt(t) || symbols.label(t) : null });
        } else res.indirectCalls++;
      } else if (isReturn(b)) {
        res.returns++;
      } else if (/^b\./.test(b) || b === 'cbz' || b === 'cbnz' || b === 'tbz' || b === 'tbnz') {
        res.condBranches++;
        const t = referenceTarget(b, opsStr);
        if (t != null && t <= addr) res.loops.push({ from: addr, to: t });
      } else if (b === 'b') {
        const t = referenceTarget(b, opsStr);
        if (t != null && t <= addr) res.loops.push({ from: addr, to: t });
      }

      // Consume the previous ADRP fact before invalidating a destination. This
      // preserves the canonical `adrp x8; add x8,x8,#imm` pair, but any later
      // overwrite of x8 kills the stale page instead of manufacturing a ref.
      let nextPage = null;
      if (b === 'adrp' && destReg != null && ops[1] && ops[1].value != null) {
        nextPage = { reg: destReg, value: ops[1].value, row };
      } else if (b === 'add') {
        const src = ops[1];
        const imm = ops[2];
        if (src?.k === 'reg' && imm?.k === 'imm' && imm.value != null) {
          const p = pageOf.get(src.num);
          if (p && row - p.row <= 8) res.stringRefs.push({ row, addr: p.value + imm.value });
        }
      } else if (b === 'ldr') {
        const mem = ops.find((x) => x.k === 'mem');
        if (mem?.base && mem.disp?.value != null) {
          const p = pageOf.get(mem.base.num);
          if (p && row - p.row <= 8) res.stringRefs.push({ row, addr: p.value + mem.disp.value, load: true });
        }
      }
      if (destReg != null) pageOf.delete(destReg);
      if (nextPage) pageOf.set(nextPage.reg, { value: nextPage.value, row: nextPage.row });
    }
  }

  throwIfAborted(signal);
  res.argRegs = Array.from(argsRead).sort((a, b) => a - b);
  res.savesCallee = Array.from(calleeSaved).sort((a, b) => a - b);
  res.setsReturnValue = lastX0Write >= 0;
  const seen = new Set();
  res.loops = res.loops.filter((l) => {
    const k = l.from + ':' + l.to;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const name = symbols && symbols.nameAt ? symbols.nameAt(res.startAddr) : null;
  res.model = buildSemanticModel(rawInsns, {
    startRow, endRow: end, name,
    symbolFor: (a) => (symbols ? (symbols.nameAt(a) || null) : null),
    rowOfAddress: (a) => {
      if (a == null) return null;
      const rel = a - region.vmAddr;
      if (rel < 0n || rel >= region.size) return null;
      return Number(rel / 4n);
    },
  });
  if ((truncated || modelRowsDropped) && res.model) res.model.truncated = true;
  res.truncated = truncated || !!res.model?.truncated;
  res.requestedRows = requestedRows;
  res.analyzedRows = rows;
  return res;
}

const CACHE_MAX = 24;
const cache = new LRU(CACHE_MAX);

function cacheKey(region, startRow, endRow, symbols, maxRows = MAX_INSTRUCTIONS) {
  const symbolGen = symbols && symbols.gen != null ? symbols.gen : 0;
  const regionRevision = region?.revision ?? region?.gen ?? region?.generation ?? 0;
  return [symbolGen, region?.id, String(region?.vmAddr ?? ''), String(region?.size ?? ''), regionRevision, startRow, endRow, 'rows=' + maxRows].join(':');
}

export function clearAnalysisCache() { cache.clear(); }

export async function analyzeFunctionCached(backend, region, startRow, endRow, symbols, onProgress, opts = {}) {
  const signal = opts?.signal || null;
  throwIfAborted(signal);
  const budget = rowBudget(opts);
  const key = cacheKey(region, startRow, endRow, symbols, budget);
  const wantTexts = opts.texts !== false;
  const hit = cache.get(key);
  if (hit) {
    if (onProgress) onProgress(1);
    if (wantTexts && !hit.textsResolved) {
      try {
        await resolveModelTexts(backend, hit.model, MODEL_TEXTS, { signal });
        hit.textsResolved = true;
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        /* keep analysis */
      }
    }
    throwIfAborted(signal);
    return hit;
  }
  const res = await analyzeFunction(backend, region, startRow, endRow, symbols, onProgress, { ...opts, maxRows: budget, signal });
  res.textsResolved = false;
  if (wantTexts) {
    try {
      await resolveModelTexts(backend, res.model, MODEL_TEXTS, { signal });
      res.textsResolved = true;
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      /* keep analysis */
    }
  }
  throwIfAborted(signal);
  cache.set(key, res);
  return res;
}

export async function resolveModelTexts(backend, model, limit = MODEL_TEXTS, opts = {}) {
  const signal = opts?.signal || null;
  throwIfAborted(signal);
  if (!model || !backend || !model.addressRefs.length) return model;
  const wanted = [];
  const seen = new Set();
  for (const r of model.addressRefs) {
    const k = r.addr.toString();
    if (seen.has(k)) continue;
    seen.add(k);
    wanted.push(r.addr);
    if (wanted.length >= limit) break;
  }
  const read = async (addr) => {
    try {
      return await awaitAbortable(backend.readAt(addr, 120, true, { signal }), signal);
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      return null;
    }
  };
  const texts = new Map();
  const indirect = new Set();
  const got = await Promise.all(wanted.map(read));
  throwIfAborted(signal);
  const deref = [];
  got.forEach((g, i) => {
    if (looksLikeText(g)) { texts.set(wanted[i].toString(), g.text); return; }
    if (g && g.found && g.bytes && g.bytes.length >= 8) deref.push({ i, bytes: g.bytes });
  });
  if (deref.length) {
    const ptrs = deref.map((d) => pointerAt(d.bytes));
    const got2 = await Promise.all(ptrs.map((ptr) => ptr == null ? Promise.resolve(null) : read(ptr)));
    throwIfAborted(signal);
    got2.forEach((g, k) => {
      if (!looksLikeText(g)) return;
      const key = wanted[deref[k].i].toString();
      texts.set(key, g.text);
      indirect.add(key);
    });
  }
  throwIfAborted(signal);
  return attachTexts(model, texts, indirect);
}

function looksLikeText(g) {
  if (!g || !g.found || !g.text) return false;
  if (!g.terminated) return false;
  if (g.text.length < 2) return false;
  return /[\p{L}\p{N}]/u.test(g.text);
}

function pointerAt(bytes) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  if (v === 0n) return null;
  if (v < 0x0001000000000000n) return v;
  return v & 0x0000000fffffffffn;
}

const HINTS = [
  [/malloc|calloc|realloc|operator new|_Znwm/i, 'メモリを確保'],
  [/free|operator delete|_ZdlPv/i, 'メモリを解放'],
  [/memcpy|memmove|bcopy/i, 'データをコピー'],
  [/memset|bzero/i, 'データを埋める'],
  [/strcmp|strncmp|memcmp/i, '文字列を比較'],
  [/strlen|strnlen/i, '文字列の長さを調べる'],
  [/strcpy|strncpy|strcat|snprintf|sprintf|asprintf/i, '文字列を組み立て'],
  [/printf|NSLog|os_log|fprintf/i, 'ログを出力'],
  [/objc_msgSend/i, 'Objective-C のメソッドを呼び出し'],
  [/objc_retain|objc_release|objc_autorelease/i, '参照カウントを操作'],
  [/swift_(retain|release|allocObject)/i, 'Swift のオブジェクトを管理'],
  [/open|fopen|read|write|close|NSFileManager/i, 'ファイルを読み書き'],
  [/socket|connect|send|recv|CFNetwork|NSURLSession|curl/i, 'ネットワーク通信'],
  [/SecItem|Keychain/i, 'キーチェーン（秘密情報）を操作'],
  [/CC(Crypt|SHA|HMAC)|AES|SHA256|MD5|CryptoKit/i, '暗号・ハッシュ計算'],
  [/pthread|dispatch_(async|sync)|NSOperation/i, '並行処理'],
  [/NSUserDefaults|CFPreferences/i, '設定を読み書き'],
  [/UIAlert|NSAlert|presentViewController/i, '画面を表示'],
  [/sqlite3|CoreData|NSManagedObject/i, 'データベースを操作'],
  [/gettimeofday|mach_absolute_time|NSDate|clock/i, '時刻を取得'],
  [/rand|arc4random|SecRandom/i, '乱数を生成'],
  [/dlopen|dlsym/i, '動的にライブラリを読み込み'],
  [/ptrace|sysctl|isDebug|AmIBeingDebugged/i, 'デバッガの検出（解析対策の可能性）'],
];

export function guessPurpose(calls) {
  const hits = [];
  for (const c of calls) {
    if (!c.name) continue;
    for (const [re, label] of HINTS) if (re.test(c.name) && !hits.includes(label)) hits.push(label);
  }
  return hits;
}

export function describeFunction(res, name) {
  const lines = [];
  const ja = pick(true, false);
  const who = name ? '「' + name + '」' : 'この関数';
  if (!ja) {
    lines.push(`${name || 'This function'} spans ${res.instructions} instructions.`);
    if (res.savesLr) lines.push('It saves the return address, so it calls other functions.');
    else lines.push('It never saves the return address — a leaf function that calls nothing.');
    if (res.loops.length) lines.push(`There are ${res.loops.length} backward branches, so it loops.`);
    if (res.calls.length) lines.push('It calls: ' + res.calls.slice(0, 8).map((c) => c.name || '0x' + c.target?.toString(16)).join(', '));
    return lines;
  }
  if (res.instructions <= 6) lines.push(who + 'はとても短く、命令は ' + res.instructions + ' 個だけです。値をそのまま返すだけ、といった小さな処理でしょう。');
  else if (res.instructions < 60) lines.push(who + 'は命令 ' + res.instructions + ' 個。ひと目で追える大きさです。');
  else if (res.instructions < 400) lines.push(who + 'は命令 ' + res.instructions + ' 個。それなりの処理をしています。');
  else lines.push(who + 'は命令 ' + res.instructions + ' 個もあります。大きな処理か、コンパイラが他の関数を取り込んだ結果でしょう。');

  if (res.savesLr || res.calls.length || res.indirectCalls) {
    if (res.calls.length) {
      const named = res.calls.filter((c) => c.name);
      if (named.length) {
        const list = [];
        for (const c of named) if (!list.includes(c.name)) list.push(c.name);
        lines.push('中で ' + list.slice(0, 6).map((n) => '「' + n + '」').join('、') + (list.length > 6 ? ' などあわせて ' + list.length + ' 種類' : '') + ' を呼んでいます。');
      } else lines.push(res.calls.length + ' 回、別の関数を呼んでいます（名前の情報は残っていません）。');
    }
    if (res.indirectCalls) lines.push('レジスタ経由の呼び出しが ' + res.indirectCalls + ' か所あります。行き先は実行してみないと分かりません（関数ポインタや Objective-C のメソッド呼び出しです）。');
  } else lines.push('他の関数は呼んでいません。自分だけで完結する末端の処理です。');

  const purpose = guessPurpose(res.calls);
  if (purpose.length) lines.push('呼んでいる相手から推測すると、' + purpose.slice(0, 4).join('・') + '、といったことをしていそうです。');
  if (res.loops.length) lines.push('前の行へ戻る分岐が ' + res.loops.length + ' か所あるので、ループが入っています。同じ処理を何度も繰り返す関数です。');
  else if (res.condBranches === 0) lines.push('条件分岐がないので、上から下へ一直線に流れます。いちばん読みやすい形です。');
  else lines.push('条件分岐が ' + res.condBranches + ' か所。if 文で枝分かれしています。');

  if (res.argRegs.length) lines.push('自分で値を入れる前に ' + res.argRegs.map((n) => 'x' + n).join('、') + ' を読んでいるので、引数を ' + res.argRegs.length + ' 個くらい受け取っていそうです。');
  else lines.push('引数用のレジスタ (x0〜x7) を読んでいないので、引数はなさそうです。');
  if (res.setsReturnValue) lines.push('帰る前に x0 を作っているので、呼び出し元へ値を返しています。');
  if (res.frameBytes > 0) lines.push('スタックを ' + res.frameBytes + ' バイト確保しています。' + (res.frameBytes >= 256 ? 'かなり大きいので、配列やバッファを置いている可能性があります。' : 'ローカル変数の置き場です。'));
  if (res.savesCallee.length >= 4) lines.push('x19〜x28 を ' + res.savesCallee.length + ' 本も退避しているので、値をたくさん抱えて動く関数です。');
  const notes = [];
  if (res.usesFloat) notes.push('小数の計算');
  if (res.usesSimd) notes.push('まとめて処理する SIMD 命令');
  if (res.usesAtomic) notes.push('スレッド間で壊れないようにする排他アクセス');
  if (res.hasTrap) notes.push('「ここには来ないはず」という停止命令');
  if (notes.length) lines.push(notes.join('、') + ' が出てきます。');
  if (res.dataRows > 0) lines.push('命令として読めない 4 バイトが ' + res.dataRows + ' 行あります。定数や飛び先表などのデータが混ざっています。');
  if (res.truncated) lines.push('※ 大きすぎるため、先頭から ' + MAX_INSTRUCTIONS.toLocaleString() + ' 命令ぶんだけを見ています。');
  return lines;
}
