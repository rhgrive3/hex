import { matchText, matchName } from './goals.js';
import { vendorOf, vendorInText, vendorConflicts, classFromSymbol } from './vendors.js';

export const REASON = {
  STRING_REF: 'string-ref', NAME: 'name-match', CALLEE_NAME: 'callee-name', CALLER_NAME: 'caller-name',
  CALLS_MATCH: 'calls-match', CALLED_BY_MATCH: 'called-by-match', NUMERIC: 'numeric', STORE: 'store',
  COMPARE: 'compare', POPULAR: 'popular', SIZE_PENALTY: 'size-penalty', VENDOR: 'vendor', NO_EVIDENCE: 'no-evidence',
};
const POINTS = {
  [REASON.STRING_REF]: 20, [REASON.NAME]: 25, [REASON.CALLEE_NAME]: 12, [REASON.CALLER_NAME]: 10,
  [REASON.CALLS_MATCH]: 8, [REASON.CALLED_BY_MATCH]: 8, [REASON.NUMERIC]: 12, [REASON.STORE]: 8,
  [REASON.COMPARE]: 6, [REASON.POPULAR]: 5, [REASON.SIZE_PENALTY]: -6, [REASON.VENDOR]: -34,
};
const KIND_OF = {
  [REASON.STRING_REF]: 'fact', [REASON.NAME]: 'fact', [REASON.CALLEE_NAME]: 'fact', [REASON.CALLER_NAME]: 'fact',
  [REASON.CALLS_MATCH]: 'inference', [REASON.CALLED_BY_MATCH]: 'inference', [REASON.NUMERIC]: 'fact', [REASON.STORE]: 'fact',
  [REASON.COMPARE]: 'fact', [REASON.POPULAR]: 'fact', [REASON.SIZE_PENALTY]: 'inference', [REASON.VENDOR]: 'fact',
};
export function reasonKind(code) { return KIND_OF[code] || 'inference'; }
export function scoreToConfidence(score) { return score > 0 ? 1 - Math.exp(-score / 45) : 0; }
export function stars(confidence) { return confidence >= 0.85 ? 5 : confidence >= 0.7 ? 4 : confidence >= 0.5 ? 3 : confidence >= 0.3 ? 2 : 1; }

function combinedMatcher(goal) {
  const parts = [];
  for (const re of goal.strong || []) parts.push(re.source);
  for (const re of goal.weak || []) parts.push(re.source);
  for (const term of goal.extraTerms || []) parts.push(term.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!parts.length) return null;
  try { return new RegExp(parts.join('|'), 'i'); } catch { return null; }
}
function vendorOfCandidate(c, learned) {
  if (c.name) {
    const v = vendorOf(classFromSymbol(c.name) || c.name, learned);
    if (v) return { ...v, where: 'name', name: c.name };
  }
  for (const s of c.strings || []) {
    const v = vendorInText(s.text);
    if (v) return { ...v, where: 'string', text: s.text };
  }
  return null;
}

function fairPrefix(values, max) {
  if (values.length <= max) return { values, complete: true };
  /* Keep the strongest half while reserving the other half for stratified tail
     samples. Rank 301+ can therefore seed a candidate without an unbounded xref
     expansion. */
  const head = Math.floor(max / 2);
  const out = values.slice(0, head);
  const tailSlots = max - head;
  const tailSize = values.length - head;
  const seen = new Set(out.map((x) => `${x.addr}:${x.text}`));
  for (let i = 0; i < tailSlots; i++) {
    const index = head + Math.min(tailSize - 1, Math.floor((i + 0.5) * tailSize / tailSlots));
    const item = values[index];
    const key = `${item.addr}:${item.text}`;
    if (!seen.has(key)) { seen.add(key); out.push(item); }
  }
  return { values: out, complete: false };
}

export function rankCandidates({ goal, strings, program, symbols, region, limit = 40, vendors = null }) {
  const notes = [], byAddr = new Map();
  if (!goal) return { candidates: [], matchedStrings: [], notes: ['no-goal'] };
  const numericLimit = Number(limit);
  const resultLimit = Number.isFinite(numericLimit) && numericLimit > 0 ? Math.floor(numericLimit) : 0;
  const hasProgram = !!(program && program.callCount + program.refCount > 0);
  if (!hasProgram) notes.push('no-program-index');

  const candidate = (addr, site) => {
    if (addr == null) return null;
    const key = addr.toString();
    let c = byAddr.get(key);
    if (!c) {
      c = { addr, name: symbols ? (symbols.nameAt(addr) || null) : null, score: 0, reasons: [], strings: [], stats: null, firstSite: site != null ? site : addr };
      byAddr.set(key, c);
    }
    return c;
  };
  const addReason = (c, code, points, detail) => {
    if (!c) return;
    c.reasons.push({ code, points: Math.round(points), kind: reasonKind(code), detail: detail || null });
    c.score += points;
  };

  const matchedStrings = [];
  for (const s of strings || []) {
    const m = matchText(goal, s.text);
    if (m) matchedStrings.push({ addr: s.addr, text: s.text, score: m.score, term: m.term, region: s.region });
  }
  matchedStrings.sort((a, b) => b.score - a.score);
  const STRING_EXPANSION_BUDGET = 1200;
  const selectedStrings = fairPrefix(matchedStrings, STRING_EXPANSION_BUDGET);
  if (!selectedStrings.complete) notes.push(`string-matches-sampled:${selectedStrings.values.length}/${matchedStrings.length}`);
  let referenced = 0;
  for (const ms of selectedStrings.values) {
    if (!hasProgram) break;
    const span = BigInt(Math.max(1, Math.min(ms.text.length, 256)));
    const users = program.functionsReferencing(ms.addr, span, 60);
    if (users.length) referenced++;
    for (const u of users) {
      const c = candidate(u.addr != null ? u.addr : u.site, u.site);
      if (!c) continue;
      const nth = c.strings.length;
      const factor = nth === 0 ? 1 : nth === 1 ? 0.6 : nth === 2 ? 0.35 : 0;
      c.strings.push({ addr: ms.addr, text: ms.text, site: u.site, kind: u.kind, users: users.length, score: ms.score, complete: users.complete !== false });
      if (factor > 0) addReason(c, REASON.STRING_REF, POINTS[REASON.STRING_REF] * ms.score * factor, {
        text: ms.text, addr: ms.addr, site: u.site, term: ms.term, refKind: u.kind,
        users: users.length, complete: users.complete !== false,
      });
    }
  }
  if (hasProgram && matchedStrings.length && !referenced) notes.push('strings-unreferenced');

  /* Preserve latest-main behaviour: collect all name matches, sort by match
     quality, then cap. An address-order first-400 cap is biased. */
  const matcher = combinedMatcher(goal);
  if (matcher && symbols?.symbolCount) {
    const lo = region ? region.vmAddr : null, hi = region ? region.vmAddr + region.size : null;
    const matches = [];
    for (let i = 0; i < symbols.addrs.length; i++) {
      const a = symbols.addrs[i];
      if (lo != null && (a < lo || a >= hi)) continue;
      const name = symbols.names[i];
      if (!name || !matcher.test(name)) continue;
      const m = matchName(goal, name);
      if (m) matches.push({ a, name, m });
    }
    matches.sort((a, b) => b.m.score - a.m.score || String(a.name).localeCompare(String(b.name)));
    if (matches.length > 400) notes.push('name-matches-capped');
    for (const { a, name, m } of matches.slice(0, 400)) {
      const start = symbols.functionCount ? (symbols.isFunctionStart(a) ? a : null) : a;
      const c = candidate(start != null ? start : a, a);
      if (!c) continue;
      c.name = c.name || name;
      addReason(c, REASON.NAME, POINTS[REASON.NAME] * m.score, { name, term: m.term });
    }
  }

  const tainted = (name) => {
    if (!name) return false;
    const v = vendorOf(classFromSymbol(name) || name, vendors);
    return !!v && vendorConflicts(goal.id, v);
  };
  if (hasProgram) {
    const seeds = Array.from(byAddr.values()).sort((a, b) => b.score - a.score).slice(0, 40);
    for (const seed of seeds) {
      const range = program.functionRange(seed.addr);
      /* Unknown end means "unknown body", never "from here to EOF". Callee
         evidence is valid only for an exact, bounded containing function. */
      if (range && range.start === seed.addr && range.end != null) {
        for (const callee of program.calleesOf(range.start, range.end, 40)) {
          const name = symbols ? symbols.nameAt(callee.addr) : null;
          const m = name && !tainted(name) ? matchName(goal, name) : null;
          if (m) addReason(seed, REASON.CALLEE_NAME, POINTS[REASON.CALLEE_NAME] * m.score, { name, addr: callee.addr, site: callee.site });
          if (seed.score >= 20 && !tainted(seed.name)) {
            const c = candidate(callee.addr, callee.site);
            if (c && c !== seed && !c.reasons.some((r) => r.code === REASON.CALLED_BY_MATCH)) {
              addReason(c, REASON.CALLED_BY_MATCH, POINTS[REASON.CALLED_BY_MATCH], { from: seed.addr, fromName: seed.name, site: callee.site });
            }
          }
        }
      } else notes.push('callee-range-unknown:' + seed.addr.toString());

      for (const caller of program.callersOf(seed.addr, 40)) {
        if (caller.addr == null) continue;
        const name = symbols ? symbols.nameAt(caller.addr) : null;
        const m = name && !tainted(name) ? matchName(goal, name) : null;
        if (m) addReason(seed, REASON.CALLER_NAME, POINTS[REASON.CALLER_NAME] * m.score, { name, addr: caller.addr, site: caller.site });
        if (seed.score >= 20 && !tainted(seed.name)) {
          const c = candidate(caller.addr, caller.site);
          if (c && c !== seed && !c.reasons.some((r) => r.code === REASON.CALLS_MATCH)) {
            addReason(c, REASON.CALLS_MATCH, POINTS[REASON.CALLS_MATCH], { to: seed.addr, toName: seed.name, site: caller.site });
          }
        }
      }
    }
  }

  const expects = goal.expects || {};
  for (const c of byAddr.values()) {
    if (!hasProgram) break;
    const range = program.functionRange(c.addr);
    if (!range || range.start !== c.addr || range.end == null) continue;
    const stats = program.statsOf(range.start, range.end);
    c.stats = stats; c.range = range;
    if (!stats.total) continue;
    if (expects.numeric && stats.numeric > 0) addReason(c, REASON.NUMERIC, Math.min(POINTS[REASON.NUMERIC], 4 * stats.numeric), { mul: stats.mul, div: stats.div, fmul: stats.fmul, farith: stats.farith, complete: stats.covered !== false });
    if (expects.store && stats.store > 0) addReason(c, REASON.STORE, POINTS[REASON.STORE], { n: stats.store, complete: stats.covered !== false });
    if (expects.compare && stats.cmp > 0) addReason(c, REASON.COMPARE, POINTS[REASON.COMPARE], { n: stats.cmp, complete: stats.covered !== false });
    const called = program.callCountOf(c.addr);
    if (called >= 3) addReason(c, REASON.POPULAR, POINTS[REASON.POPULAR], { n: called, complete: !program.callsCapped });
    c.calledCount = called;
    if (stats.total > 1500) addReason(c, REASON.SIZE_PENALTY, POINTS[REASON.SIZE_PENALTY], { n: stats.total, complete: stats.covered !== false });
  }

  for (const c of byAddr.values()) {
    const vendor = vendorOfCandidate(c, vendors);
    if (!vendor) continue;
    c.vendor = vendor;
    if (vendorConflicts(goal.id, vendor)) addReason(c, REASON.VENDOR, POINTS[REASON.VENDOR], {
      vendor: vendor.vendor, kind: vendor.kind, where: vendor.where,
      name: vendor.name || null, text: vendor.text || null,
    });
  }

  const out = [];
  for (const c of byAddr.values()) {
    if (c.score <= 0) continue;
    c.confidence = scoreToConfidence(c.score); c.stars = stars(c.confidence);
    c.reasons.sort((a, b) => b.points - a.points); out.push(c);
  }
  out.sort((a, b) => b.score - a.score || (a.addr < b.addr ? -1 : 1));
  return {
    candidates: out.slice(0, resultLimit), matchedStrings, notes, total: out.length,
    matchedStringsComplete: selectedStrings.complete,
  };
}

export function breakdown(candidate) {
  if (!candidate) return [];
  const merged = new Map();
  for (const r of candidate.reasons) {
    const key = r.code + ':' + (r.detail?.name || '');
    if (!merged.has(key)) merged.set(key, { ...r, points: 0, count: 0 });
    const m = merged.get(key); m.count++; m.points += r.points;
  }
  return Array.from(merged.values()).sort((a, b) => b.points - a.points);
}
