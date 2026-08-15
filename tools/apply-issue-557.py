from pathlib import Path

p = Path('js/agent/runtime.js')
text = p.read_text()
old = '''function deterministicAnswer(plan) {
  const best = plan && plan.best;
  if (!best) {
    return {
      conclusion: null,
      reasons: [],
      evidence: plan && plan.evidence || [],
      confidence: 0,
      missingEvidence: plan && plan.missingEvidence && plan.missingEvidence.length ? plan.missingEvidence : ['no-verified-candidate'],
    };
  }
  const verdict = best.verification?.verdict?.status || best.verification?.verdict || best.verification?.status || null;
  const verified = best.verification?.verified === true || verdict === 'confirmed' || verdict === 'supported';
  const semanticCount = (best.semanticFacts || []).length;
  return {
    conclusion: { address: best.address, name: best.name || null },
    reasons: [
      { kind: 'semantic-facts', count: semanticCount },
      { kind: 'deterministic-verification', verified },
      { kind: 'candidate-score', score: best.score },
    ],
    evidence: plan.evidence || [],
    confidence: verified ? 0.98 : (semanticCount ? 0.78 : 0.45),
    missingEvidence: plan.missingEvidence || [],
  };
}
'''
new = '''function finiteConfidence(value, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function verificationVerdict(verification) {
  const raw = verification?.verdict;
  const status = typeof raw === 'string' ? raw : (raw?.status || verification?.status || null);
  const confidence = finiteConfidence(raw && typeof raw === 'object' ? raw.confidence : verification?.confidence, null);
  return { status: status ? String(status) : null, confidence };
}

function confidenceFromEvidence({ semanticCount, explicitVerified, verdictStatus, verdictConfidence }) {
  const staticConfidence = semanticCount ? 0.78 : 0.45;
  if (!verdictStatus) return explicitVerified ? 0.98 : staticConfidence;

  if (verdictStatus === 'confirmed') {
    // Runtime confirmation is itself the strongest source. Never manufacture a
    // confidence above the verifier's own calibrated confidence.
    return Math.min(0.98, verdictConfidence ?? 0.98);
  }
  if (verdictStatus === 'supported') {
    // Partial runtime support may strengthen a weak static candidate slightly,
    // but it can never escape the source verdict's confidence envelope.
    const cap = Math.min(0.85, verdictConfidence ?? 0.85);
    return Math.min(cap, staticConfidence + 0.10);
  }
  if (verdictStatus === 'contradicted') {
    // Verdict confidence measures confidence in the contradiction, so invert it
    // when expressing confidence in the candidate conclusion.
    const contradiction = Math.max(0.70, verdictConfidence ?? 0.70);
    return Math.min(staticConfidence, Math.max(0, 1 - contradiction));
  }
  if (verdictStatus === 'inconclusive') {
    return Math.min(staticConfidence, verdictConfidence ?? 0.25, 0.25);
  }
  if (verdictStatus === 'unsupported') return 0;
  // Unknown verifier statuses are evidence, not permission to upgrade.
  return Math.min(staticConfidence, verdictConfidence ?? staticConfidence);
}

export function deterministicAnswer(plan) {
  const best = plan && plan.best;
  if (!best) {
    return {
      conclusion: null,
      reasons: [],
      evidence: plan && plan.evidence || [],
      confidence: 0,
      missingEvidence: plan && plan.missingEvidence && plan.missingEvidence.length ? plan.missingEvidence : ['no-verified-candidate'],
    };
  }
  const { status: verdict, confidence: verdictConfidence } = verificationVerdict(best.verification);
  const explicitVerified = best.verification?.verified === true;
  const verified = explicitVerified || verdict === 'confirmed';
  const semanticCount = (best.semanticFacts || []).length;
  const reasons = [
    { kind: 'semantic-facts', count: semanticCount },
    { kind: 'deterministic-verification', verified },
  ];
  if (verdict) reasons.push({
    kind: `runtime-${verdict}`,
    status: verdict,
    confidence: verdictConfidence,
    verified: verdict === 'confirmed',
  });
  reasons.push({ kind: 'candidate-score', score: best.score });
  return {
    conclusion: { address: best.address, name: best.name || null },
    reasons,
    evidence: plan.evidence || [],
    confidence: confidenceFromEvidence({ semanticCount, explicitVerified, verdictStatus: verdict, verdictConfidence }),
    missingEvidence: plan.missingEvidence || [],
  };
}
'''
if new not in text:
    if old not in text: raise SystemExit('deterministicAnswer anchor not found')
    text = text.replace(old, new, 1)
p.write_text(text)

p = Path('tests/runtime-platform.mjs')
text = p.read_text()
imp = "import { deterministicAnswer } from '../js/agent/runtime.js';\n"
if imp not in text:
    anchor = "import { RuntimeAnalysisPlatform } from '../js/runtime/index.js';\n"
    if anchor not in text: raise SystemExit('runtime-platform import anchor not found')
    text = text.replace(anchor, anchor + imp, 1)

marker = '// #557 Agent final answer must preserve runtime verdict strength.'
if marker not in text:
    block = r'''

// #557 Agent final answer must preserve runtime verdict strength.
{
  const runtimeCases = (status, count) => Array.from({ length: count }, () => ({ comparison: { status } }));
  const supported1 = classifyHypothesis(runtimeCases('supported', 1));
  const supported2 = classifyHypothesis(runtimeCases('supported', 2));
  const confirmed3 = classifyHypothesis(runtimeCases('supported', 3));
  const contradicted = classifyHypothesis(runtimeCases('contradicted', 1));
  const inconclusive = classifyHypothesis(runtimeCases('inconclusive', 1));
  assert.equal(supported1.status, 'supported'); assert.equal(supported1.confidence, 0.60);
  assert.equal(supported2.status, 'supported'); assert.equal(supported2.confidence, 0.65);
  assert.equal(confirmed3.status, 'confirmed'); assert.equal(confirmed3.confidence, 0.87);
  assert.equal(contradicted.status, 'contradicted');
  assert.equal(inconclusive.status, 'inconclusive');

  const answerFor = (verdict, semanticCount = 0, extraVerification = {}) => deterministicAnswer({
    best: {
      address: 0x1000n,
      name: 'candidate',
      score: 42,
      semanticFacts: Array.from({ length: semanticCount }, (_, i) => ({ kind: `fact-${i}` })),
      verification: { verdict, ...extraVerification },
    },
    evidence: ['fixture:evidence'],
    missingEvidence: [],
  });

  const one = answerFor(supported1);
  assert.equal(one.reasons.find((r) => r.kind === 'deterministic-verification').verified, false);
  assert.equal(one.reasons.find((r) => r.kind === 'runtime-supported').status, 'supported');
  assert.ok(one.confidence <= supported1.confidence);
  assert.ok(one.confidence < 0.98);

  const twoWithStatic = answerFor(supported2, 3);
  assert.equal(twoWithStatic.confidence, supported2.confidence, 'static evidence must not lift a supported verdict above its source confidence');
  assert.equal(twoWithStatic.reasons.some((r) => r.kind === 'runtime-confirmed'), false);

  const confirmed = answerFor(confirmed3, 1);
  assert.equal(confirmed.reasons.find((r) => r.kind === 'deterministic-verification').verified, true);
  assert.equal(confirmed.reasons.find((r) => r.kind === 'runtime-confirmed').verified, true);
  assert.equal(confirmed.confidence, confirmed3.confidence);

  const contradictedAnswer = answerFor(contradicted, 4);
  assert.equal(contradictedAnswer.reasons.find((r) => r.kind === 'deterministic-verification').verified, false);
  assert.ok(contradictedAnswer.confidence <= 1 - contradicted.confidence + Number.EPSILON);
  assert.ok(contradictedAnswer.reasons.some((r) => r.kind === 'runtime-contradicted'));

  const inconclusiveAnswer = answerFor(inconclusive, 2);
  assert.ok(inconclusiveAnswer.confidence <= 0.25);
  assert.ok(inconclusiveAnswer.reasons.some((r) => r.kind === 'runtime-inconclusive'));

  const unsupported = answerFor({ status: 'unsupported', confidence: 0 }, 2);
  assert.equal(unsupported.confidence, 0);
  assert.equal(unsupported.reasons.find((r) => r.kind === 'deterministic-verification').verified, false);

  // An explicit non-runtime verification contract remains valid, but a
  // contradictory/supported runtime verdict still owns its confidence ceiling.
  const explicitStatic = deterministicAnswer({ best: { address: 0x2000n, score: 1, semanticFacts: [], verification: { verified: true } }, evidence: [], missingEvidence: [] });
  assert.equal(explicitStatic.confidence, 0.98);
  const inconsistentSupported = answerFor(supported1, 1, { verified: true });
  assert.ok(inconsistentSupported.confidence <= supported1.confidence);
  assert.ok(inconsistentSupported.reasons.some((r) => r.kind === 'runtime-supported'));
}
'''
    # Place directly after the existing hypothesis verdict block so the runtime
    # evidence policy stays next to its source classifier fixtures.
    anchor = "// Evidence independence and binary scoping.\n"
    if anchor not in text: raise SystemExit('runtime-platform fixture anchor not found')
    text = text.replace(anchor, block + '\n' + anchor, 1)
p.write_text(text)
