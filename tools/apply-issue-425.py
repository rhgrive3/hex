from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, found {count}')
    p.write_text(text.replace(old, new, 1))


replace_once('js/query/planner.js',
"""    disassemblyExhausted: false,
    functionExhausted: false,
    analysisAccountedExternally: !!(opts && opts.tools),
""",
"""    disassemblyExhausted: false,
    functionExhausted: false,
    candidateTruncated: false,
    candidateCount: 0,
    analysisAccountedExternally: !!(opts && opts.tools),
""")

replace_once('js/query/planner.js',
"""async function analyzeCandidates(query, map, tools, b) {
  const list = Array.from(map.values()).sort((a, b2) => b2.score - a.score).slice(0, b.maxFunctions);
  const analyzed = [];
""",
"""async function analyzeCandidates(query, map, tools, b) {
  const ordered = Array.from(map.values()).sort((a, b2) => b2.score - a.score);
  b.candidateCount = ordered.length;
  b.candidateTruncated = ordered.length > b.maxFunctions;
  const list = ordered.slice(0, b.maxFunctions);
  const analyzed = [];
""")

replace_once('js/query/planner.js',
"""function publicCandidate(c) {
  if (!c) return null;
  return {
""",
"""function publicCandidate(c, completeness = null) {
  if (!c) return null;
  return {
""")

replace_once('js/query/planner.js',
"""    verification: c.verification || null,
    evidence: Array.from(c.evidence || []),
  };
}
""",
"""    verification: c.verification || null,
    evidence: Array.from(c.evidence || []),
    complete: completeness ? completeness.complete === true : true,
    budgetLimited: completeness ? completeness.budgetLimited === true : false,
  };
}
""")

replace_once('js/query/planner.js',
"""  if (b.disassemblyExhausted) missingEvidence.push('disassembly-budget');
  if (b.functionExhausted) missingEvidence.push('function-budget');
  if (timedOut(b)) missingEvidence.push('timeout');
  if (b.isCancelled()) missingEvidence.push('cancelled');
  if (query.confident === false) missingEvidence.push(...(query.missing || []));

  return {
    query,
    candidates: ranked.slice(0, Math.min(20, b.maxFunctions)).map(publicCandidate),
    best: publicCandidate(best),
    evidence: Array.from(evidence),
    missingEvidence: Array.from(new Set(missingEvidence)),
    exhausted: expired(b),
    stats: {
      analyzedFunctions: ranked.length,
      candidateFunctions: candidates.size,
      disassembly: b.analyzedInstructions,
      elapsedMs: Date.now() - b.started,
    },
    engine: 'deterministic-goal-planner',
  };
""",
"""  if (b.disassemblyExhausted) missingEvidence.push('disassembly-budget');
  if (b.functionExhausted || b.candidateTruncated) missingEvidence.push('function-budget');
  if (timedOut(b)) missingEvidence.push('timeout');
  if (b.isCancelled()) missingEvidence.push('cancelled');
  if (query.confident === false) missingEvidence.push(...(query.missing || []));

  const incomplete = expired(b) || b.candidateTruncated;
  const budgetLimited = b.disassemblyExhausted || b.functionExhausted || b.candidateTruncated;
  const candidateCount = candidates.size;
  const analyzedCount = ranked.length;
  const candidateCoverage = candidateCount === 0 ? 1 : Math.min(1, analyzedCount / candidateCount);
  const reason = b.candidateTruncated || b.functionExhausted ? 'function-budget'
    : b.disassemblyExhausted ? 'disassembly-budget'
      : timedOut(b) ? 'timeout'
        : b.isCancelled() ? 'cancelled' : null;
  const completeness = {
    complete: !incomplete,
    partial: incomplete,
    budgetLimited,
    reason,
    candidateCoverage,
    analyzedFunctions: analyzedCount,
    candidateFunctions: candidateCount,
    unalyzedFunctions: Math.max(0, candidateCount - analyzedCount),
  };

  return {
    query,
    candidates: ranked.slice(0, Math.min(20, b.maxFunctions)).map((c) => publicCandidate(c, completeness)),
    best: publicCandidate(best, completeness),
    evidence: Array.from(evidence),
    missingEvidence: Array.from(new Set(missingEvidence)),
    exhausted: incomplete,
    partial: incomplete,
    completeness: { ...completeness, unalyzedFunctions: undefined, unananlyzedFunctions: undefined, unprocessedFunctions: Math.max(0, candidateCount - analyzedCount) },
    stats: {
      analyzedFunctions: analyzedCount,
      candidateFunctions: candidateCount,
      unananlyzedFunctions: undefined,
      unprocessedFunctions: Math.max(0, candidateCount - analyzedCount),
      unalyzedFunctions: undefined,
      unprocessedCandidateFunctions: Math.max(0, candidateCount - analyzedCount),
      disassembly: b.analyzedInstructions,
      elapsedMs: Date.now() - b.started,
    },
    engine: 'deterministic-goal-planner',
  };
""")

# Clean field names in the return shape after the large structural replacement.
p = Path('js/query/planner.js')
t = p.read_text()
t = t.replace("    unalyzedFunctions: Math.max(0, candidateCount - analyzedCount),\n", "    unanalyzedFunctions: Math.max(0, candidateCount - analyzedCount),\n")
t = t.replace("    completeness: { ...completeness, unalyzedFunctions: undefined, unananlyzedFunctions: undefined, unprocessedFunctions: Math.max(0, candidateCount - analyzedCount) },\n", "    completeness,\n")
t = t.replace("      unananlyzedFunctions: undefined,\n      unprocessedFunctions: Math.max(0, candidateCount - analyzedCount),\n      unalyzedFunctions: undefined,\n      unprocessedCandidateFunctions: Math.max(0, candidateCount - analyzedCount),\n", "      unanalyzedFunctions: Math.max(0, candidateCount - analyzedCount),\n")
p.write_text(t)

replace_once('package.json',
"""\"semantic:test\": \"node tests/ir-dataflow.mjs""",
"""\"semantic:test\": \"node tests/issue-425-planner-budget.mjs && node tests/ir-dataflow.mjs""")
