/*
 * 関数 1 つぶんのレポート。
 *
 * このファイルの役目はただ 1 つ — **事実と推測を分けること**。
 *
 *   FACT      … バイナリから直接読み取れる。反論の余地がない。
 *               「0x100123456 に str w8, [x0, #0x20] がある」
 *   INFERENCE … 事実から組み立てた解釈。確度と根拠が必ず付く。
 *               「この関数はダメージ計算に関係している可能性が高い（78%）」
 *   UNKNOWN   … 分からない。分からないと言う。埋めない。
 *               「この呼び出しの行き先は実行時に決まるので追えません」
 *
 * これを混ぜた瞬間に、このツールは「それっぽいことを言う機械」になる。
 * だから型のレベルで分けている。
 *
 * 日本語は作らない。コードと詳細だけを返し、文にするのは narrate.js。
 */
import { levelOf, SCORE } from './blocks.js';
import { buildCfg } from './cfg.js';
import { findValueUpdates, constantComparisons, hotLocations } from './dataflow.js';
import { matchText } from './goals.js';
import { comprehend } from './comprehend.js';
import { stackNaming } from './decompile.js';

export const CERTAINTY = { FACT: 'fact', INFERENCE: 'inference', UNKNOWN: 'unknown' };

function fact(code, detail, row) {
  return { certainty: CERTAINTY.FACT, code, detail: detail || null, row: row == null ? -1 : row };
}
function inference(code, confidence, evidence, detail) {
  return {
    certainty: CERTAINTY.INFERENCE, code,
    confidence: Math.max(0, Math.min(1, confidence)),
    level: levelOf(confidence),
    evidence: evidence || [],
    detail: detail || null,
  };
}
function unknown(code, detail) {
  return { certainty: CERTAINTY.UNKNOWN, code, detail: detail || null };
}

function completenessOf(program) {
  if (!program) return { callsComplete: false, refsComplete: false, statsComplete: false };
  const graph = program.graphCompleteness || null;
  return {
    callsComplete: graph?.callsComplete === true,
    refsComplete: graph?.refsComplete === true,
    statsComplete: graph?.statsComplete === true || (!graph && program.statsComplete === true),
  };
}

/**
 * @param {object} opts
 *   model    buildSemanticModel の結果
 *   region   セクション
 *   symbols  SymbolIndex
 *   program  ProgramIndex（あれば呼び出し関係まで書ける）
 *   goal     調べている目的（あれば「目的との関係」も書く）
 *   name     関数の名前
 */
export function buildFunctionReport(opts) {
  const o = opts || {};
  const model = o.model;
  if (!model) return null;
  const region = o.region || null;
  const symbols = o.symbols || null;
  const program = o.program || null;
  const goal = o.goal || null;
  const completeness = completenessOf(program);

  const startAddr = model.startAddress != null ? model.startAddress
    : (region ? region.vmAddr + BigInt(model.startRow) * 4n : null);
  const endAddr = region ? region.vmAddr + BigInt(model.endRow) * 4n : null;
  const rowOfAddress = region
    ? (a) => {
      if (a == null) return null;
      const rel = a - region.vmAddr;
      if (rel < 0n || rel >= region.size) return null;
      return Number(rel / 4n);
    }
    : () => null;

  const f = model.facts || {};
  const facts = [];
  const inferences = [];
  const unknowns = [];

  /* ── FACT: 数えられるもの ─────────────────────────────── */

  facts.push(fact('instructions', { n: f.instructionCount || 0 }));
  if (f.calls) facts.push(fact('calls', { n: f.calls, named: f.namedCalls || 0 }));
  if (f.loops) facts.push(fact('loops', { n: f.loops }));
  if (f.conditionals) facts.push(fact('conditionals', { n: f.conditionals }));
  if (f.loads || f.stores) facts.push(fact('memory', { loads: f.loads || 0, stores: f.stores || 0 }));
  if (f.setsReturnValue) facts.push(fact('returns-value', null));
  if (f.argRegs && f.argRegs.length) facts.push(fact('arguments', { regs: f.argRegs }));

  for (const c of (f.calledNames || []).slice(0, 12)) {
    facts.push(fact('call-named', { name: c.name, target: c.target }, c.row));
  }
  const selectors = [];
  for (const c of model.calls || []) {
    if (c.selector && !selectors.includes(c.selector)) {
      selectors.push(c.selector);
      facts.push(fact('selector', { selector: c.selector, row: c.row }, c.row));
    }
  }
  const strings = [];
  for (const s of (f.stringRefs || [])) {
    if (!s.text) continue;
    if (strings.some((x) => x.text === s.text)) continue;
    strings.push({ text: s.text, addr: s.addr, row: s.row });
    if (strings.length <= 12) facts.push(fact('string-ref', { text: s.text, addr: s.addr }, s.row));
  }

  /* ── FACT: 値の変更（load → 演算 → store） ─────────────── */

  const updates = findValueUpdates(model);
  /*
   * Objective-C のクラス表が読めていれば、ここで「x0 + 0x20」を
   * 「BattleManager の hp」に置き換える。読めていなければ、そのままにする
   * （分からないものに名前を付けない）。
   */
  const fieldIndex = o.fields || null;
  const owner = o.owner || (fieldIndex && startAddr != null ? fieldIndex.ownerOf(startAddr) : null);
  if (fieldIndex && owner) {
    for (const u of updates) {
      u.field = fieldIndex.resolveAccess(
        { base: u.location.base, disp: u.location.disp, self: u.location.self === true }, owner.className);
    }
  }

  for (const u of updates.slice(0, 8)) {
    facts.push(fact('value-update', {
      kind: u.kind,
      base: u.location.base, disp: u.location.disp, size: u.location.size,
      stack: u.location.stack,
      field: u.field || null,
      ops: u.steps.map((s) => ({ op: s.op, imm: s.imm, row: s.row })),
      loadRow: u.from ? u.from.row : null,
      storeRow: u.store.row,
      confidence: u.confidence,
    }, u.store.row));
  }

  const comparisons = constantComparisons(model);
  for (const c of comparisons.slice(0, 8)) {
    facts.push(fact('compare-const', { value: c.value, float: c.float, register: c.register }, c.row));
  }

  const locations = hotLocations(model);
  if (fieldIndex && owner) {
    for (const loc of locations) {
      loc.field = fieldIndex.resolveAccess({ base: loc.base, disp: loc.disp, self: loc.self === true }, owner.className);
    }
  }

  /* ── FACT: 呼び出し関係（プログラム全体の索引から） ───── */

  let callers = [];
  let callees = [];
  if (program && startAddr != null) {
    const range = program.functionRange(startAddr) || { start: startAddr, end: endAddr };
    callers = program.callersOf(range.start, 60).map((c) => ({
      addr: c.addr, site: c.site, count: c.count,
      name: c.addr != null && symbols ? symbols.nameAt(c.addr) : null,
    }));
    callees = program.calleesOf(range.start, range.end, 60).map((c) => ({
      addr: c.addr, site: c.site, count: c.count,
      name: symbols ? symbols.nameAt(c.addr) : null,
    }));
    if (callers.length) facts.push(fact('callers', { n: callers.length }));
    if (!callers.length && completeness.callsComplete) facts.push(fact('no-callers', null));
    const stats = program.statsOf(range.start, range.end);
    if (stats.numeric) {
      facts.push(fact('numeric', {
        mul: stats.mul, div: stats.div, fmul: stats.fmul, farith: stats.farith,
      }));
    }
    if (stats.indcall) facts.push(fact('indirect-calls', { n: stats.indcall }));
  } else if (f.indirectCalls) {
    facts.push(fact('indirect-calls', { n: f.indirectCalls }));
  }

  /* ── INFERENCE: 何をしている関数か ─────────────────────── */

  if (f.features && f.features.length) {
    inferences.push(inference('purpose-feature', f.confidence || SCORE.inferred,
      (f.evidence || []).slice(0, 6), { features: f.features, categories: f.categories }));
  }
  if (selectors.length) {
    inferences.push(inference('purpose-selector', SCORE.high,
      selectors.slice(0, 5).map((s) => ({ code: 'selector', detail: { selector: s } })),
      { selectors: selectors.slice(0, 5) }));
  }
  for (const u of updates.slice(0, 3)) {
    if (u.kind !== 'read-modify-write') continue;
    /*
     * 読み書きの往復が閉じていることは「事実」だが、
     * それがこの関数の扱っている値そのものだという解釈は推測。
     * どれだけ証拠がそろっても、推測を 100% とは言わない。
     */
    inferences.push(inference('value-holder', Math.min(u.confidence, 0.9), u.evidence, {
      base: u.location.base, disp: u.location.disp, field: u.field || null,
      op: u.steps.length ? u.steps[u.steps.length - 1].op : null,
      imm: u.steps.length ? u.steps[u.steps.length - 1].imm : null,
      storeRow: u.store.row,
    }));
  }
  if (comparisons.length && f.conditionals) {
    inferences.push(inference('threshold-check', SCORE.inferred,
      comparisons.slice(0, 3).map((c) => ({ code: 'compare-const', detail: { value: c.value } })),
      { n: comparisons.length }));
  }

  /* 目的との関係。目的が与えられているときだけ。 */
  if (goal) {
    const hits = [];
    for (const s of strings) {
      const m = matchText(goal, s.text);
      if (m) hits.push({ code: 'string-ref', sourceGroup: 'strings', detail: { text: s.text, addr: s.addr, term: m.term } });
    }
    for (const sel of selectors) {
      const m = matchText(goal, sel);
      if (m) hits.push({ code: 'selector', sourceGroup: 'selectors', detail: { selector: sel, term: m.term } });
    }
    if (o.name) {
      const m = matchText(goal, o.name);
      if (m) hits.push({ code: 'name-match', sourceGroup: 'symbol-name', detail: { name: o.name, term: m.term } });
    }
    for (const c of callers.slice(0, 20)) {
      if (!c.name) continue;
      const m = matchText(goal, c.name);
      if (m) hits.push({ code: 'caller-name', sourceGroup: 'caller-names', detail: { name: c.name, term: m.term } });
    }
    if (hits.length) {
      const byGroup = new Map();
      for (const hit of hits) {
        const key = hit.sourceGroup || hit.code;
        byGroup.set(key, (byGroup.get(key) || 0) + 1);
      }
      // Repeated observations from one evidence family are correlated; they
      // add only diminishing support instead of masquerading as independence.
      let effective = 0;
      for (const n of byGroup.values()) effective += 1 + Math.min(0.5, Math.max(0, n - 1) * 0.15);
      const conf = Math.min(0.92, 0.35 + 0.18 * effective);
      inferences.push(inference('goal-related', conf, hits.slice(0, 6), {
        goal: goal.id, label: goal.text || goal.ja,
        independentEvidenceGroups: byGroup.size, rawEvidenceCount: hits.length,
      }));
    } else {
      unknowns.push(unknown('goal-unrelated', { goal: goal.id }));
    }
  }

  /* ── UNKNOWN: 言えないこと ─────────────────────────────── */

  if (f.indirectCalls) unknowns.push(unknown('indirect-target', { n: f.indirectCalls }));
  if (f.calls > f.namedCalls) unknowns.push(unknown('unnamed-calls', { n: f.calls - f.namedCalls }));
  if (!strings.length) unknowns.push(unknown('no-strings', null));
  if (model.truncated) unknowns.push(unknown('truncated', null));
  if (program && !completeness.statsComplete) unknowns.push(unknown('stats-partial', null));
  if (program && !completeness.callsComplete) {
    unknowns.push(unknown('callers-partial', {
      reason: program.graphCompleteness?.callsComplete === false ? 'call-graph-capped' : 'call-graph-completeness-unknown',
      observed: callers.length,
    }));
  }
  // 静的解析だけでは、実行時にその値が何であるかまでは決められない。必ず言う。
  unknowns.push(unknown('runtime-meaning', null));

  /* ── 次に何をすればいいか ─────────────────────────────── */

  const nextSteps = [];
  if (callers.length) nextSteps.push({ code: 'check-callers', detail: { n: callers.length } });
  else if (program && !completeness.callsComplete) {
    nextSteps.push({ code: 'check-callers-incomplete', detail: { reason: 'call-graph-incomplete' } });
  } else nextSteps.push({ code: 'no-callers-hint', detail: null });
  if (f.argRegs && f.argRegs.length) nextSteps.push({ code: 'check-inputs', detail: { regs: f.argRegs } });
  if (f.setsReturnValue) nextSteps.push({ code: 'check-return', detail: null });
  if (updates.length) {
    nextSteps.push({
      code: 'check-updates',
      detail: { n: updates.length, addr: updates[0].store.address },
    });
  }
  if (callees.length) nextSteps.push({ code: 'check-callees', detail: { n: callees.length } });
  if (comparisons.length) nextSteps.push({ code: 'check-thresholds', detail: { n: comparisons.length } });
  nextSteps.push({ code: 'verify-runtime', detail: null });

  /* ── 変更候補 ─────────────────────────────────────────────
     「ここを変えれば目的の値が変わる」と**言い切らない**のが肝。
     根拠と、何が保証できないのかを必ず添えて返す。 */

  const editTargets = updates.filter((u) => u.kind === 'read-modify-write').slice(0, 6).map((u) => ({
    address: u.store.address,
    row: u.store.row,
    location: u.location,
    field: u.field || null,
    from: u.from,
    steps: u.steps,
    confidence: u.confidence,
    level: u.level,
    evidence: u.evidence,
    caveat: 'runtime-unverified',
  }));

  /* ── 計算の連なりを 1 本に戻す（comprehend.js） ─────────────
     ここまでの facts は「何が何回あったか」の数え上げで、大きな関数では
     何も言っていないに等しい。命令をまたいで式に戻したものだけが、
     「この関数は何を計算しているのか」に答えられる。 */
  let comprehension = null;
  try {
    comprehension = comprehend({
      model,
      symbolFor: symbols ? (a) => symbols.nameAt(a) : null,
    });
  } catch { comprehension = null; }   /* 復元に失敗しても、レポートは出す */
  /* 置き場の呼び名。逆コンパイル画面と同じ名前で出すために持ち回る。 */
  if (comprehension) {
    try { comprehension.naming = stackNaming(model); } catch { comprehension.naming = null; }
  }

  return {
    owner,
    comprehension,
    identity: {
      name: o.name || model.name || null,
      startAddr, endAddr,
      startRow: model.startRow, endRow: model.endRow,
      instructions: f.instructionCount || 0,
    },
    completeness,
    facts, inferences, unknowns,
    callers, callees,
    strings, selectors,
    updates, editTargets, comparisons, locations,
    cfg: buildCfg(model, { rowOfAddress }),
    nextSteps,
    confidence: f.confidence != null ? f.confidence : SCORE.unknown,
  };
}

/** レポートを 3 つに分けて取り出す。UI はこの 3 つを別々の見た目で出す。 */
export function split(report) {
  if (!report) return { facts: [], inferences: [], unknowns: [] };
  return { facts: report.facts, inferences: report.inferences, unknowns: report.unknowns };
}