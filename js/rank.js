/*
 * 「今見るべきもの」を決める、説明できる点数付け。
 *
 * このファイルの絶対のきまり:
 *
 *   1. 名前の一致だけで上位に来させない。
 *      名前・文字列・参照関係・命令の実在という、独立した証拠を足し合わせる。
 *   2. 点数の内訳を必ず残す。「なぜ 87% なのか」を 1 点ずつ説明できるようにする。
 *      AI 的なブラックボックス判定はしない。
 *   3. 「事実 (fact)」と「解釈 (inference)」を、証拠 1 つずつに書き分ける。
 *      「この関数が 0x1004A2B0 を参照している」は事実。
 *      「だからダメージ計算だ」は解釈。混ぜない。
 *
 * 日本語は作らない。理由コードだけを持たせ、文にするのは narrate.js。
 */
import { matchText, matchName } from './goals.js';

/* ── 証拠の種類と配点 ────────────────────────────────────────
   数字はここに集めてある。UI にはこの数字がそのまま出る。 */

export const REASON = {
  STRING_REF: 'string-ref',        // その目的の文字列を、この関数が参照している
  NAME: 'name-match',              // 関数自身の名前が目的に合う
  CALLEE_NAME: 'callee-name',      // 目的に合う名前の処理を呼んでいる
  CALLER_NAME: 'caller-name',      // 目的に合う名前の処理から呼ばれている
  CALLS_MATCH: 'calls-match',      // 有力候補を呼んでいる
  CALLED_BY_MATCH: 'called-by-match', // 有力候補から呼ばれている
  NUMERIC: 'numeric',              // 数値計算をしている（掛け算・割り算・小数）
  STORE: 'store',                  // 値をメモリへ書き戻している
  COMPARE: 'compare',              // 値を比べている（しきい値の判定）
  POPULAR: 'popular',              // あちこちから呼ばれている
  SIZE_PENALTY: 'size-penalty',    // 大きすぎて、特定の計算とは考えにくい
  NO_EVIDENCE: 'no-evidence',
};

const POINTS = {
  [REASON.STRING_REF]: 20,
  [REASON.NAME]: 25,
  [REASON.CALLEE_NAME]: 12,
  [REASON.CALLER_NAME]: 10,
  [REASON.CALLS_MATCH]: 8,
  [REASON.CALLED_BY_MATCH]: 8,
  [REASON.NUMERIC]: 12,
  [REASON.STORE]: 8,
  [REASON.COMPARE]: 6,
  [REASON.POPULAR]: 5,
  [REASON.SIZE_PENALTY]: -6,
};

/** 証拠 1 件が「事実」か「解釈」か。UI はここで見た目を変える。 */
const KIND_OF = {
  [REASON.STRING_REF]: 'fact',       // 参照が存在すること自体は事実
  [REASON.NAME]: 'fact',             // 名前がそう書いてあることは事実
  [REASON.CALLEE_NAME]: 'fact',
  [REASON.CALLER_NAME]: 'fact',
  [REASON.CALLS_MATCH]: 'inference',
  [REASON.CALLED_BY_MATCH]: 'inference',
  [REASON.NUMERIC]: 'fact',
  [REASON.STORE]: 'fact',
  [REASON.COMPARE]: 'fact',
  [REASON.POPULAR]: 'fact',
  [REASON.SIZE_PENALTY]: 'inference',
};

export function reasonKind(code) { return KIND_OF[code] || 'inference'; }

/* ── 点数 → 確からしさ ──────────────────────────────────────
   点が増えるほど 1 に近づくが、決して 1 にはならない。
   静的解析だけで「確実」と言えることはないため。 */

export function scoreToConfidence(score) {
  if (!(score > 0)) return 0;
  return 1 - Math.exp(-score / 45);
}

export function stars(confidence) {
  if (confidence >= 0.85) return 5;
  if (confidence >= 0.7) return 4;
  if (confidence >= 0.5) return 3;
  if (confidence >= 0.3) return 2;
  return 1;
}

/** 目的の語をまとめた 1 本の正規表現。名前の総当たりを 1 回で済ませるため。 */
function combinedMatcher(goal) {
  const parts = [];
  for (const re of goal.strong || []) parts.push(re.source);
  for (const re of goal.weak || []) parts.push(re.source);
  for (const term of goal.extraTerms || []) {
    parts.push(term.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  if (!parts.length) return null;
  try { return new RegExp(parts.join('|'), 'i'); } catch { return null; }
}

/**
 * 候補を並べる。
 *
 * @param {object} opts
 *   goal      目的（goals.js）
 *   strings   [{addr, text, region}] 収集済みの文字列
 *   program   ProgramIndex（なくても動くが、根拠は薄くなる）
 *   symbols   SymbolIndex
 *   region    コードのセクション
 *   limit     返す件数
 * @returns {{candidates:Array, matchedStrings:Array, notes:Array<string>}}
 */
export function rankCandidates({ goal, strings, program, symbols, region, limit = 40 }) {
  const notes = [];
  const byAddr = new Map();      // 関数の先頭(string) -> 候補

  if (!goal) return { candidates: [], matchedStrings: [], notes: ['no-goal'] };
  const hasProgram = !!(program && program.callCount + program.refCount > 0);
  if (!hasProgram) notes.push('no-program-index');

  const candidate = (addr, site) => {
    if (addr == null) return null;
    const key = addr.toString();
    let c = byAddr.get(key);
    if (!c) {
      c = {
        addr,
        name: symbols ? (symbols.nameAt(addr) || null) : null,
        score: 0, reasons: [], strings: [], stats: null,
        firstSite: site != null ? site : addr,
      };
      byAddr.set(key, c);
    }
    return c;
  };

  const addReason = (c, code, points, detail) => {
    if (!c) return;
    c.reasons.push({ code, points: Math.round(points), kind: reasonKind(code), detail: detail || null });
    c.score += points;
  };

  /* ── 1. 文字列 → その文字列を参照している関数 ──────────────
     ここが「テキストを見て推測する」からの決別点。
     文字列が一致しただけでは候補にしない。
     その文字列を実際に参照している命令があって初めて候補になる。 */

  const matchedStrings = [];
  for (const s of strings || []) {
    const m = matchText(goal, s.text);
    if (!m) continue;
    matchedStrings.push({ addr: s.addr, text: s.text, score: m.score, term: m.term, region: s.region });
  }
  matchedStrings.sort((a, b) => b.score - a.score);

  const USE_STRINGS = 300;      // 濃いものから順に、この数まで参照元をたどる
  let referenced = 0;
  for (const ms of matchedStrings.slice(0, USE_STRINGS)) {
    if (!hasProgram) break;
    const span = BigInt(Math.max(1, Math.min(ms.text.length, 256)));
    const users = program.functionsReferencing(ms.addr, span, 60);
    if (users.length) referenced++;
    for (const u of users) {
      const c = candidate(u.addr != null ? u.addr : u.site, u.site);
      if (!c) continue;
      // 同じ関数が同じ目的の文字列を何本も参照していても、点は逓減させる
      const nth = c.strings.length;
      const factor = nth === 0 ? 1 : nth === 1 ? 0.6 : nth === 2 ? 0.35 : 0;
      c.strings.push({ addr: ms.addr, text: ms.text, site: u.site, kind: u.kind });
      if (factor > 0) {
        addReason(c, REASON.STRING_REF, POINTS[REASON.STRING_REF] * ms.score * factor, {
          text: ms.text, addr: ms.addr, site: u.site, term: ms.term, refKind: u.kind,
        });
      }
    }
  }
  if (hasProgram && matchedStrings.length && !referenced) notes.push('strings-unreferenced');

  /* ── 2. 名前 ────────────────────────────────────────────────
     Objective-C のメソッド名は人が付けたものなので強い手がかり。
     ただし名前だけでは上位に行かないよう、配点は文字列参照と同程度に留める。 */

  const matcher = combinedMatcher(goal);
  if (matcher && symbols && symbols.symbolCount) {
    const lo = region ? region.vmAddr : null;
    const hi = region ? region.vmAddr + region.size : null;
    let scanned = 0;
    for (let i = 0; i < symbols.addrs.length; i++) {
      const a = symbols.addrs[i];
      if (lo != null && (a < lo || a >= hi)) continue;
      const name = symbols.names[i];
      if (!name || !matcher.test(name)) continue;
      const m = matchName(goal, name);
      if (!m) continue;
      const start = symbols.functionCount ? (symbols.isFunctionStart(a) ? a : null) : a;
      const c = candidate(start != null ? start : a, a);
      if (!c) continue;
      c.name = c.name || name;
      addReason(c, REASON.NAME, POINTS[REASON.NAME] * m.score, { name, term: m.term });
      if (++scanned >= 400) { notes.push('name-matches-capped'); break; }
    }
  }

  /* ── 3. 呼び出し関係 ────────────────────────────────────────
     「BattleManager から呼ばれている」「HP を触る処理を呼んでいる」を、
     推測ではなく bl の辺として確かめる。 */

  if (hasProgram) {
    const seeds = Array.from(byAddr.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 40);
    for (const seed of seeds) {
      const range = program.functionRange(seed.addr);
      const end = range ? range.end : null;

      for (const callee of program.calleesOf(seed.addr, end, 40)) {
        const name = symbols ? symbols.nameAt(callee.addr) : null;
        const m = name ? matchName(goal, name) : null;
        if (m) {
          addReason(seed, REASON.CALLEE_NAME, POINTS[REASON.CALLEE_NAME] * m.score,
            { name, addr: callee.addr, site: callee.site });
        }
        // 有力候補が呼んでいる先も、候補として拾っておく（下流に本体があることが多い）
        if (seed.score >= 20) {
          const c = candidate(callee.addr, callee.site);
          if (c && c !== seed && !c.reasons.some((r) => r.code === REASON.CALLED_BY_MATCH)) {
            addReason(c, REASON.CALLED_BY_MATCH, POINTS[REASON.CALLED_BY_MATCH],
              { from: seed.addr, fromName: seed.name, site: callee.site });
          }
        }
      }

      for (const caller of program.callersOf(seed.addr, 40)) {
        if (caller.addr == null) continue;
        const name = symbols ? symbols.nameAt(caller.addr) : null;
        const m = name ? matchName(goal, name) : null;
        if (m) {
          addReason(seed, REASON.CALLER_NAME, POINTS[REASON.CALLER_NAME] * m.score,
            { name, addr: caller.addr, site: caller.site });
        }
        if (seed.score >= 20) {
          const c = candidate(caller.addr, caller.site);
          if (c && c !== seed && !c.reasons.some((r) => r.code === REASON.CALLS_MATCH)) {
            addReason(c, REASON.CALLS_MATCH, POINTS[REASON.CALLS_MATCH],
              { to: seed.addr, toName: seed.name, site: caller.site });
          }
        }
      }
    }
  }

  /* ── 4. 命令の実在 ──────────────────────────────────────────
     「値を計算して書き戻している」かどうかは、名前ではなく命令で確かめる。
     ここは走査済みの分類表を数えるだけなので、逆アセンブルは走らない。 */

  const expects = goal.expects || {};
  for (const c of byAddr.values()) {
    if (!hasProgram) break;
    const range = program.functionRange(c.addr);
    // 関数の先頭として分かっていないアドレス（スタブなど）は、どこまでが本体か
    // 決められない。よその関数の統計を貼り付けるくらいなら、何も言わない。
    if (!range || range.start !== c.addr) continue;
    const stats = program.statsOf(range.start, range.end);
    c.stats = stats;
    c.range = range;
    if (!stats.total) continue;

    if (expects.numeric && stats.numeric > 0) {
      addReason(c, REASON.NUMERIC, Math.min(POINTS[REASON.NUMERIC], 4 * stats.numeric),
        { mul: stats.mul, div: stats.div, fmul: stats.fmul, farith: stats.farith });
    }
    if (expects.store && stats.store > 0) {
      addReason(c, REASON.STORE, POINTS[REASON.STORE], { n: stats.store });
    }
    if (expects.compare && stats.cmp > 0) {
      addReason(c, REASON.COMPARE, POINTS[REASON.COMPARE], { n: stats.cmp });
    }
    const called = program.callCountOf(c.addr);
    if (called >= 3) {
      addReason(c, REASON.POPULAR, POINTS[REASON.POPULAR], { n: called });
    }
    c.calledCount = called;
    // 数千命令の関数は、目的の計算そのものというより「全部入り」であることが多い
    if (stats.total > 1500) {
      addReason(c, REASON.SIZE_PENALTY, POINTS[REASON.SIZE_PENALTY], { n: stats.total });
    }
  }

  /* ── 5. まとめ ─────────────────────────────────────────── */

  const out = [];
  for (const c of byAddr.values()) {
    if (c.score <= 0) continue;
    c.confidence = scoreToConfidence(c.score);
    c.stars = stars(c.confidence);
    // 内訳は大きい順に。UI はここを上から出すだけでよい。
    c.reasons.sort((a, b) => b.points - a.points);
    out.push(c);
  }
  out.sort((a, b) => b.score - a.score || (a.addr < b.addr ? -1 : 1));

  return {
    candidates: out.slice(0, limit),
    matchedStrings,
    notes,
    total: out.length,
  };
}

/**
 * 候補 1 つの点数の内訳。UI がそのまま並べられる形にする。
 * @returns {Array<{code:string, points:number, kind:string, detail:object}>}
 */
export function breakdown(candidate) {
  if (!candidate) return [];
  const merged = new Map();
  for (const r of candidate.reasons) {
    const key = r.code + ':' + (r.detail && r.detail.name ? r.detail.name : '');
    if (!merged.has(key)) merged.set(key, Object.assign({}, r, { points: 0, count: 0 }));
    const m = merged.get(key);
    m.count++;
    m.points += r.points;      // 合計が候補の点数と一致するようにする
  }
  return Array.from(merged.values()).sort((a, b) => b.points - a.points);
}
