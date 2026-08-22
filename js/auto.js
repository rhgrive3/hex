/*
 * 自動解析 — 利用者が何も指示しなくても、分かることを全部やる。
 * 重い処理は索引 → 採点 → pinpoint → 深掘りの順で、失敗を隠さない。
 */
import { GOALS, goalFromPreset } from './goals.js';
import { rankCandidates } from './rank.js';
import { vendorsOf } from './vendors.js';
import { groupByFeature, detectEngine } from './features.js';
import { findValueUpdates, constantComparisons } from './dataflow.js';
import { buildAppMap, buildStringMap } from './appmap.js';
import { pinpointField, pinpointFunction, pinpointLocation } from './pinpoint.js';
import { VERDICT, verdictRank } from './evidence.js';
import { inferRole } from './role.js';

const SIGNALS = [
  { id: 'endpoint', level: 'high', re: /^https?:\/\/[^\s"']{4,}/i, max: 12 },
  { id: 'anticheat', level: 'high', re: /jailbr|jailbroken|cydia|frida|substrate|tamper|integrity|debugger|ptrace|sandbox_?check|不正|改造|チート/i, max: 8 },
  { id: 'crypto', level: 'normal', re: /\baes\b|\bsha(1|256|512)\b|\bhmac\b|\brsa\b|encrypt|decrypt|cipher|keychain|private_?key/i, max: 8 },
  { id: 'ads', level: 'normal', re: /admob|applovin|unityads|ironsource|vungle|tapjoy|adjust\.com|appsflyer|interstitial|rewarded/i, max: 6 },
  { id: 'purchase', level: 'high', re: /storekit|skpayment|receipt|verifyreceipt|subscription|in_?app_?purchase/i, max: 6 },
  { id: 'debuglog', level: 'low', re: /\bdebug\b|verbose|assert|\bTODO\b|FIXME/i, max: 4 },
  { id: 'path', level: 'low', re: /^\/(Users|var|private|tmp|Applications)\/[^\s"']{4,}/, max: 6 },
];

function lowerBoundBig(values, target) {
  let lo = 0, hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Fairly sample the whole function range rather than silently taking the first
 * N addresses. This prevents late executable regions/functions from starving.
 */
function fairFunctionList(symbols, region, max = 20000) {
  if (!symbols?.funcs?.length || !region) return symbols?.functionList?.(region, max) || [];
  const lo = region.vmAddr;
  const hi = region.vmAddr + region.size;
  const first = lowerBoundBig(symbols.funcs, lo);
  const last = lowerBoundBig(symbols.funcs, hi);
  const total = Math.max(0, last - first);
  if (!total) return [];
  const count = Math.min(max, total);
  const indexes = [];
  if (total <= max) {
    for (let i = first; i < last; i++) indexes.push(i);
  } else {
    const seen = new Set();
    for (let slot = 0; slot < count; slot++) {
      const rel = count === 1 ? 0 : Math.round(slot * (total - 1) / (count - 1));
      const idx = first + rel;
      if (!seen.has(idx)) { seen.add(idx); indexes.push(idx); }
    }
  }
  const out = indexes.map((idx) => {
    const addr = symbols.funcs[idx];
    const fn = symbols.functionAt(addr);
    return { addr, name: symbols.nameAt(addr) || null, size: fn?.end != null ? fn.end - addr : null };
  });
  Object.defineProperties(out, {
    complete: { value: total <= max, enumerable: false },
    sampled: { value: total > max, enumerable: false },
    totalFunctions: { value: total, enumerable: false },
  });
  return out;
}

export function notableFunctions(program, symbols, region, limit = 12) {
  if (!program || !symbols || !symbols.functionCount) return [];
  const list = fairFunctionList(symbols, region, 20000);
  const out = [];
  for (const f of list) {
    const range = program.functionRange(f.addr);
    if (!range || range.end == null) continue;
    const stats = program.statsOf(range.start, range.end);
    if (!stats.total) continue;
    const called = program.callCountOf(f.addr);
    const reasons = [];
    let score = 0;
    if (called >= 2) {
      const p = Math.min(18, called * 3); score += p;
      reasons.push({ code: 'called', points: p, detail: { n: called } });
    }
    if (stats.numeric) {
      const p = Math.min(12, stats.numeric * 3); score += p;
      reasons.push({ code: 'numeric', points: p, detail: { mul: stats.mul, div: stats.div, fmul: stats.fmul } });
    }
    if (stats.store && stats.load) {
      const p = Math.min(10, stats.store * 2); score += p;
      reasons.push({ code: 'readwrite', points: p, detail: { load: stats.load, store: stats.store } });
    }
    if (f.name) { score += 6; reasons.push({ code: 'named', points: 6, detail: { name: f.name } }); }
    if (stats.cmp >= 2) { score += 4; reasons.push({ code: 'compare', points: 4, detail: { n: stats.cmp } }); }
    if (stats.total > 1500) { score -= 10; reasons.push({ code: 'huge', points: -10, detail: { n: stats.total } }); }
    if (score <= 6) continue;
    out.push({ addr: f.addr, name: f.name, score, reasons, stats, called, range, sampleComplete: list.complete !== false });
  }
  out.sort((a, b) => b.score - a.score || (a.addr < b.addr ? -1 : 1));
  const result = out.slice(0, Math.max(0, Number(limit)));
  Object.defineProperties(result, {
    complete: { value: list.complete !== false, enumerable: false },
    sampled: { value: list.sampled === true, enumerable: false },
  });
  return result;
}

/**
 * Keep interesting dead/unreferenced strings visible as data, but mark them
 * explicitly non-actionable. Only proven code xrefs may drive next-step advice.
 */
export function findings(strings, program, symbols, limit = 40) {
  const out = [];
  if (!program) return out;
  for (const sig of SIGNALS) {
    let taken = 0;
    for (const s of strings || []) {
      if (taken >= sig.max || out.length >= limit) break;
      if (!sig.re.test(s.text)) continue;
      const users = program.functionsReferencing(s.addr, BigInt(Math.max(1, Math.min(s.text.length, 256))), 8);
      const actionable = users.length > 0;
      out.push({
        id: sig.id, level: sig.level, text: s.text, addr: s.addr,
        actionable,
        status: actionable ? 'referenced' : 'unreferenced',
        xrefsComplete: users.complete !== false,
        users: users.map((u) => ({
          addr: u.addr, site: u.site,
          name: u.addr != null && symbols ? symbols.nameAt(u.addr) : null,
        })),
      });
      taken++;
    }
  }
  // Proven/actionable findings always precede dead strings.
  out.sort((a, b) => Number(b.actionable) - Number(a.actionable) || b.users.length - a.users.length);
  return out;
}

export async function autoAnalyze(opts) {
  const o = opts || {};
  const { strings = [], program = null, symbols = null, region = null } = o;
  const progress = o.onProgress || (() => {});
  const cancelled = o.isCancelled || (() => false);
  const deepLimit = o.deepLimit != null ? o.deepLimit : 12;

  const report = {
    map: null, engine: null, features: [], goals: [], pinned: [], confirmed: [],
    settled: [], unsettled: [], unexamined: [], notable: [], findings: [], deep: [],
    diagnostics: [],
    stats: {
      strings: strings.length,
      calls: program ? program.callCount : 0,
      refs: program ? program.refCount : 0,
      functions: symbols ? symbols.functionCount : 0,
      statsComplete: program ? program.statsComplete : false,
      capped: !!(program && (program.callsCapped || program.refsCapped)),
    },
    notes: [],
  };

  const diagnose = (phase, error, detail = null) => {
    const type = String(error?.type || error?.code || error?.name || 'analysis_error');
    const message = String(error?.message || error || 'analysis failed').slice(0, 1000);
    const retryable = !['cancelled', 'AbortError', 'scope_violation', 'invalid_tool_call'].includes(type);
    report.diagnostics.push({ phase, type, message, retryable, detail });
  };

  progress({ phase: 'features', done: 0, all: 1 });
  report.engine = detectEngine(strings);
  report.features = groupByFeature(strings);
  report.findings = findings(strings, program, symbols);

  progress({ phase: 'map', done: 0, all: 1 });
  const fields = o.fields || null;
  report.map = (fields && fields.classCount)
    ? buildAppMap({ fields, program, symbols, strings, region })
    : buildStringMap({ program, symbols, strings });
  report.stats.classes = fields ? fields.classCount : 0;
  report.stats.fields = fields ? fields.fieldCount : 0;
  await tick();

  const all = GOALS.length;
  const rankedByGoal = new Map();
  for (let i = 0; i < GOALS.length; i++) {
    if (cancelled()) { report.notes.push('cancelled'); return report; }
    progress({ phase: 'goals', done: i, all });
    const goal = goalFromPreset(GOALS[i].id);
    const ranked = rankCandidates({ goal, strings, program, symbols, region, limit: 12, vendors: vendorsOf(fields) });
    rankedByGoal.set(goal.id, { goal, ranked });
    if (ranked.candidates.length) {
      report.goals.push({
        goal, candidates: ranked.candidates, best: ranked.candidates[0],
        matchedStrings: ranked.matchedStrings.length, notes: ranked.notes,
      });
    }
    await tick();
  }
  report.goals.sort((a, b) => b.best.score - a.best.score);

  const startBudget = o.pinpointBudget != null ? o.pinpointBudget : 360;
  const perGoal = o.pinpointPerGoal != null ? o.pinpointPerGoal : 24;
  const fieldBudget = o.pinpointFieldBudget != null ? o.pinpointFieldBudget : 7;
  const locationBudget = o.pinpointLocationBudget != null ? o.pinpointLocationBudget : 7;
  const functionBudget = o.pinpointFunctionBudget != null ? o.pinpointFunctionBudget : 12;
  const budget = { left: startBudget };
  const memo = o.analyze ? memoize(o.analyze) : null;
  const hasClasses = !!(fields && fields.classCount);

  const pinProbability = (p) => p?.top?.fusion ? p.top.fusion.probability : 0;
  const pinIdentifying = (p) => p?.top?.fusion ? (p.top.fusion.identifying || 0) : 0;
  const pinVerified = (p) => p?.top?.fusion ? (p.top.fusion.verified || 0) : 0;
  const usablePin = (p) => !!(p && p.top && pinIdentifying(p) > 0);
  const multipleVerifiedPin = (p) => usablePin(p) && p.kind === 'function' && p.verdict === VERDICT.AMBIGUOUS &&
    (p.tiedVerified || 0) >= 2 && pinVerified(p) > 0 && pinProbability(p) >= 0.99;
  const settledPin = (p) => usablePin(p) && (verdictRank(p.verdict) >= verdictRank(VERDICT.LIKELY) || multipleVerifiedPin(p));
  const beatsPin = (next, cur) => {
    if (!usablePin(next)) return false;
    if (!usablePin(cur)) return true;
    const vr = verdictRank(next.verdict) - verdictRank(cur.verdict);
    if (vr) return vr > 0;
    const pp = pinProbability(next) - pinProbability(cur);
    if (Math.abs(pp) > 1e-12) return pp > 0;
    const vv = pinVerified(next) - pinVerified(cur);
    if (vv) return vv > 0;
    return pinIdentifying(next) > pinIdentifying(cur);
  };
  const runWithBudget = async (max, fn, phase) => {
    if (budget.left <= 0 || max <= 0) return null;
    const purse = { left: Math.max(0, Math.min(max, perGoal, budget.left)) };
    const before = purse.left;
    try {
      return await fn(purse);
    } catch (error) {
      diagnose(phase || 'pinpoint', error);
      return null;
    } finally {
      budget.left -= (before - purse.left);
    }
  };

  const goalOrder = GOALS.map((g) => g.id).sort((a, b) => {
    const ea = rankedByGoal.get(a), eb = rankedByGoal.get(b);
    const sa = ea?.ranked?.candidates?.[0]?.score || 0;
    const sb = eb?.ranked?.candidates?.[0]?.score || 0;
    return sb - sa;
  });
  report.stats.pinpointModes = { field: 0, location: 0, function: 0 };

  if (memo || hasClasses) {
    for (let i = 0; i < goalOrder.length; i++) {
      if (cancelled()) { report.notes.push('pin-cancelled'); break; }
      progress({ phase: 'pinpoint', done: i, all });
      if (budget.left <= 0) {
        report.unexamined.push(...goalOrder.slice(i).map((id) => goalFromPreset(id)));
        break;
      }
      const entry = rankedByGoal.get(goalOrder[i]);
      const goal = entry ? entry.goal : goalFromPreset(goalOrder[i]);
      const ranked = entry ? entry.ranked.candidates : [];
      const common = {
        goal, fields, program, symbols, strings, region, map: report.map,
        shapes: o.shapes || null, analyze: memo, scanAccess: o.scanAccess || null,
        isCancelled: cancelled, limit: 12,
      };
      const alternatives = [];
      let best = null;

      if (hasClasses) {
        const fieldPin = await runWithBudget(fieldBudget,
          (purse) => pinpointField({ ...common, budget: purse }), `pinpoint-field:${goal.id}`);
        report.stats.pinpointModes.field++;
        if (fieldPin) alternatives.push(fieldPin);
        if (beatsPin(fieldPin, best)) best = fieldPin;
      }

      const canLocate = memo && ((common.shapes && common.shapes.size) || ranked.length);
      if (canLocate && !((best && best.verdict === VERDICT.CONFIRMED) && best.kind === 'field')) {
        const locPin = await runWithBudget(locationBudget,
          (purse) => pinpointLocation({ ...common, ranked, budget: purse }), `pinpoint-location:${goal.id}`);
        report.stats.pinpointModes.location++;
        if (locPin) alternatives.push(locPin);
        if (beatsPin(locPin, best)) best = locPin;
      }

      const canFindFunction = memo && ranked.length;
      if (canFindFunction && !(best && best.verdict === VERDICT.CONFIRMED && best.kind === 'field')) {
        let fieldHint = null;
        const named = alternatives.find((p) => p && p.kind === 'field' && p.top && settledPin(p));
        if (named) fieldHint = { offset: named.top.offset, className: named.top.className, plain: named.top.plain, name: named.top.field?.name };
        const fnPin = await runWithBudget(functionBudget,
          (purse) => pinpointFunction({ ...common, ranked, budget: purse, functionCount: symbols ? symbols.functionCount : 0, field: fieldHint }),
          `pinpoint-function:${goal.id}`);
        report.stats.pinpointModes.function++;
        if (fnPin) alternatives.push(fnPin);
        if (beatsPin(fnPin, best)) best = fnPin;
      }

      if (!usablePin(best) || best.verdict === VERDICT.NONE) continue;
      best.alternatives = alternatives.filter((p) => p && p !== best && usablePin(p));
      if (best.kind !== 'function') {
        const fn = alternatives.find((p) => p && p.kind === 'function' && usablePin(p));
        if (fn) best.function = fn;
      } else {
        const value = alternatives.filter((p) => p && p.kind !== 'function' && usablePin(p))
          .sort((a, b) => (beatsPin(a, b) ? -1 : beatsPin(b, a) ? 1 : 0))[0];
        if (value) best.value = value;
      }
      report.pinned.push(best);
      const g = report.goals.find((x) => x.goal.id === goal.id);
      if (g) g.pinned = best;
      await tick();
    }

    report.pinned.sort((a, b) => (verdictRank(b.verdict) - verdictRank(a.verdict)) || (pinProbability(b) - pinProbability(a)));
    report.confirmed = report.pinned.filter((p) => p.verdict === VERDICT.CONFIRMED);
    report.multiple = report.pinned.filter(multipleVerifiedPin);
    for (const p of report.multiple) p.resolution = 'multiple';
    report.settled = report.pinned.filter(settledPin);
    report.unsettled = report.pinned.filter((p) => !settledPin(p));
    report.stats.pinpointUsed = startBudget - budget.left;
    report.stats.pinpointBudget = startBudget;
    report.stats.goalsExamined = goalOrder.length - report.unexamined.length;
  }

  progress({ phase: 'notable', done: 0, all: 1 });
  const recognized = Array.isArray(o.recognition?.records) ? o.recognition.records : [];
  const recognizedNotable = recognized
    .filter((item) => item && (item.classification === 'APPLICATION' || item.classification === 'UNKNOWN'))
    .slice(0, 24)
    .map((item) => ({ addr:item.address, name:item.name||null, score:Math.round((item.score||0)*100), reasons:[{code:'recognition',points:Math.round((item.score||0)*100),detail:{classification:item.classification,confidence:item.confidence,knowledge:!!item.knowledge}}], recognition:item }));
  const structuralNotable = notableFunctions(program, symbols, region);
  const seen = new Set();
  report.notable = [...recognizedNotable, ...structuralNotable].filter((item) => {
    const key=item?.addr==null?'':item.addr.toString(); if(!key||seen.has(key))return false; seen.add(key); return true;
  }).slice(0, 24);
  Object.defineProperties(report.notable, {
    complete:{value:o.recognition ? o.recognition.complete===true && structuralNotable.complete!==false : structuralNotable.complete!==false,enumerable:false},
    sampled:{value:o.recognition?.complete===false || structuralNotable.sampled===true,enumerable:false},
  });
  report.stats.recognition = o.recognition ? { scanned:o.recognition.scannedCount||0,total:o.recognition.total||0,complete:o.recognition.complete===true,knowledgeMatches:o.recognition.knowledgeMatches||0 } : null;
  if (report.notable.sampled) report.notes.push('notable-functions-sampled');

  if (o.analyze && deepLimit > 0) {
    const targets = [];
    const seen = new Set();
    const push = (addr, why, goal) => {
      if (addr == null) return;
      const key = addr.toString();
      if (seen.has(key) || targets.length >= deepLimit) return;
      seen.add(key); targets.push({ addr, why, goal: goal || null });
    };
    for (const g of report.goals) {
      push(g.best.addr, 'goal', g.goal);
      if (g.candidates[1]) push(g.candidates[1].addr, 'goal', g.goal);
    }
    for (const n of report.notable) push(n.addr, 'notable', null);

    for (let i = 0; i < targets.length; i++) {
      if (cancelled()) { report.notes.push('deep-cancelled'); break; }
      progress({ phase: 'deep', done: i, all: targets.length });
      const t = targets[i];
      const range = program ? program.functionRange(t.addr) : null;
      let model = null;
      try {
        model = await (memo || o.analyze)(t.addr, range ? range.end : null);
      } catch (error) {
        diagnose('deep-analyze', error, { address: t.addr.toString() });
      }
      if (!model) continue;
      const updates = findValueUpdates(model).filter((u) => u.kind !== 'compute-store');
      const compares = constantComparisons(model);
      const owner = fields ? fields.ownerOf(t.addr) : null;
      for (const u of updates) {
        u.field = fields ? fields.resolveAccess({
          base: u.location.base, disp: u.location.disp,
          indexAddr: u.location.indexAddr, self: u.location.self,
        }, owner ? owner.className : null) : null;
      }
      const f = model.facts || {};
      const selectors = (model.calls || []).map((c) => c.selector).filter(Boolean);
      const stringFacts = f.strings || [];
      const role = inferRole({
        name: symbols ? symbols.nameAt(t.addr) : null, owner, updates,
        apis: f.apis || [], selectors,
        strings: stringFacts.map((text) => ({ text })), callees: f.calledNames || [], callers: [],
        comparisons: compares.length, conditionals: f.conditionals || 0,
        calls: f.calls || 0, stores: f.stores || 0, verified: true,
      });
      report.deep.push({
        addr: t.addr, owner, name: symbols ? symbols.nameAt(t.addr) : null,
        why: t.why, goal: t.goal ? t.goal.id : null, goalLabel: t.goal ? t.goal.text : null,
        role, updates: updates.slice(0, 4), compares: compares.slice(0, 4),
        instructions: f.instructionCount || 0, selectors: selectors.slice(0, 4), strings: stringFacts.slice(0, 3),
      });
      await tick();
    }
    report.deep.sort((a, b) => b.updates.length - a.updates.length || (b.goal ? 1 : 0) - (a.goal ? 1 : 0));
  }

  progress({ phase: 'done', done: 1, all: 1 });
  return report;
}

export function autoNextSteps(report) {
  const steps = [];
  if (!report) return steps;
  const confirmed = (report.confirmed || []).filter((p) => p.top && p.top.kind === 'field');
  if (confirmed.length) {
    const p = confirmed[0];
    const write = (p.changeSites || []).find((s) => s.stores);
    steps.push({ code: 'open-pinned', detail: { label: p.goal.text, className: p.top.className, field: p.top.plain, addr: write ? write.first : null } });
  } else {
    const split = (report.pinned || []).find((x) => x.verdict === VERDICT.AMBIGUOUS && x.top && x.top.kind === 'field');
    if (split) steps.push({ code: 'decide-ambiguous', detail: { label: split.goal.text, a: split.top.plain, b: split.runnerUp?.kind === 'field' ? split.runnerUp.plain : null } });
  }
  const withUpdates = (report.deep || []).filter((d) => d.updates.length);
  if (withUpdates.length) steps.push({ code: 'open-update', detail: { addr: withUpdates[0].updates[0].store.address, name: withUpdates[0].name } });
  if (report.goals?.length) steps.push({ code: 'open-goal', detail: { label: report.goals[0].goal.text, addr: report.goals[0].best.addr } });
  if (report.findings?.some((f) => f.id === 'endpoint' && f.actionable !== false)) steps.push({ code: 'check-endpoint', detail: null });
  if (report.findings?.some((f) => f.id === 'anticheat' && f.actionable !== false)) steps.push({ code: 'check-anticheat', detail: null });
  if (!report.goals?.length && !report.notable?.length) steps.push({ code: 'nothing-found', detail: null });
  if (report.engine) steps.push({ code: 'other-binary', detail: { engine: report.engine.id } });
  steps.push({ code: 'verify-runtime', detail: null });
  return steps;
}

function tick() { return new Promise((resolve) => setTimeout(resolve, 0)); }

/* Cache only successful, non-null analysis. Rejections/nulls are retryable. */
function memoize(analyze) {
  const cache = new Map();
  return (addr, end) => {
    const key = `${addr == null ? 'null' : addr.toString()}:${end == null ? 'null' : end.toString()}`;
    if (cache.has(key)) return cache.get(key);
    const p = Promise.resolve()
      .then(() => analyze(addr, end))
      .then((value) => {
        if (value == null) cache.delete(key);
        return value;
      }, (error) => {
        cache.delete(key);
        throw error;
      });
    cache.set(key, p);
    if (cache.size > 400) cache.delete(cache.keys().next().value);
    return p;
  };
}
