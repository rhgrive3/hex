/*
 * Response normalization.
 *
 * The AI result schema is owned by the AI core (js/ai/schema.js). This module
 * is the only place in the UI that touches its raw shape, so a schema change
 * never reaches a renderer: every renderer consumes the model produced here,
 * and unknown fields are recorded rather than dropped silently.
 *
 * Pure module — no DOM. Tested by tests/ai-ui-evidence.mjs.
 */
import { starsOf } from '../../evidence.js';

/* The four statuses of js/ai/schema.js EVIDENCE_STATUSES, plus one UI-only
   state for a hypothesis the evidence has ruled out. */
export const STATUS = Object.freeze({
  VERIFIED: 'verified',
  SUPPORTED: 'supported',
  HYPOTHESIS: 'hypothesis',
  UNKNOWN: 'unknown',
  CONTRADICTED: 'contradicted',
});

export const STATUS_TEXT = Object.freeze({
  verified: { ja: '確認済み', en: 'Verified', mark: '✓' },
  supported: { ja: '有力', en: 'Supported', mark: '≈' },
  hypothesis: { ja: '仮説', en: 'Hypothesis', mark: '?' },
  unknown: { ja: '未確認', en: 'Unknown', mark: '·' },
  contradicted: { ja: '否定', en: 'Contradicted', mark: '!' },
});

const KNOWN_FIELDS = new Set([
  'mode', 'style', 'answer', 'confidence', 'evidence', 'hypotheses', 'actions',
  'followups', 'activity', 'usage', 'limits', 'sessionId', 'error', 'task', 'proposals',
]);

const STATUS_ALIASES = new Map(Object.entries({
  verified: STATUS.VERIFIED,
  confirmed: STATUS.VERIFIED,
  proven: STATUS.VERIFIED,
  supported: STATUS.SUPPORTED,
  likely: STATUS.SUPPORTED,
  probable: STATUS.SUPPORTED,
  hypothesis: STATUS.HYPOTHESIS,
  open: STATUS.HYPOTHESIS,
  ambiguous: STATUS.HYPOTHESIS,
  unknown: STATUS.UNKNOWN,
  unverified: STATUS.UNKNOWN,
  none: STATUS.UNKNOWN,
  contradicted: STATUS.CONTRADICTED,
  rejected: STATUS.CONTRADICTED,
  refuted: STATUS.CONTRADICTED,
}));

/** Any spelling of a verdict -> one of the five UI states. */
export function normalizeStatus(value, confidence) {
  const key = String(value == null ? '' : value).toLowerCase().trim();
  if (STATUS_ALIASES.has(key)) return STATUS_ALIASES.get(key);
  const n = num(confidence);
  if (n != null) {
    if (n >= 0.7) return STATUS.SUPPORTED;
    if (n > 0) return STATUS.HYPOTHESIS;
  }
  return STATUS.UNKNOWN;
}

export function statusText(status, ja = true) {
  const item = STATUS_TEXT[status] || STATUS_TEXT.unknown;
  return ja ? item.ja : item.en;
}

export function statusMark(status) {
  return (STATUS_TEXT[status] || STATUS_TEXT.unknown).mark;
}

/* `Number(null)` is 0, so a missing score would otherwise read as "0% sure"
   instead of "not stated". Absent stays absent. */
function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function text(value, limit = 4000) {
  const out = String(value == null ? '' : value);
  return out.length > limit ? out.slice(0, limit - 1) + '…' : out;
}

/** Core addresses are already `0x…` strings; anything else is coerced once. */
export function addressString(value) {
  if (value == null) return null;
  if (typeof value === 'string') return /^0x[0-9a-f]+$/i.test(value.trim()) ? value.trim().toLowerCase() : null;
  try { return '0x' + BigInt(value).toString(16); } catch { return null; }
}

export function addressBigInt(value) {
  const hex = addressString(value);
  if (!hex) return null;
  try { return BigInt(hex); } catch { return null; }
}

/* ── answer prose -> renderable blocks ────────────────────────────────────
   A deliberately small Markdown subset. Anything richer belongs in a
   structured schema field, not in prose the UI has to guess at. */

function inlineSegments(source) {
  const out = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)/g;
  let last = 0;
  let hit;
  while ((hit = re.exec(source))) {
    if (hit.index > last) out.push({ t: 'text', v: source.slice(last, hit.index) });
    if (hit[1]) out.push({ t: 'code', v: hit[1].slice(1, -1) });
    else out.push({ t: 'strong', v: hit[2].slice(2, -2) });
    last = re.lastIndex;
  }
  if (last < source.length) out.push({ t: 'text', v: source.slice(last) });
  return out.length ? out : [{ t: 'text', v: source }];
}

export function parseAnswer(value) {
  const raw = text(value, 30000);
  if (!raw.trim()) return [];
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let bullets = [];
  let code = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: 'p', segments: inlineSegments(paragraph.join(' ').trim()) });
    paragraph = [];
  };
  const flushBullets = () => {
    if (!bullets.length) return;
    blocks.push({ type: 'bullets', items: bullets.map((item) => inlineSegments(item)) });
    bullets = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (code) { blocks.push({ type: 'code', text: code.join('\n') }); code = null; }
      else { flushParagraph(); flushBullets(); code = []; }
      continue;
    }
    if (code) { code.push(line); continue; }
    if (!line.trim()) { flushParagraph(); flushBullets(); continue; }
    const heading = /^\s*#{1,4}\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(); flushBullets();
      blocks.push({ type: 'heading', text: heading[1].trim() });
      continue;
    }
    const bullet = /^\s*(?:[-*•・]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) { flushParagraph(); bullets.push(bullet[1].trim()); continue; }
    flushBullets();
    paragraph.push(line.trim());
  }
  if (code) blocks.push({ type: 'code', text: code.join('\n') });
  flushParagraph();
  flushBullets();
  return blocks;
}

/* ── structured parts ─────────────────────────────────────────────────── */

const ACTION_KINDS = new Set([
  'open-function', 'open-address', 'show-xrefs', 'show-callers', 'show-callees',
  'trace-value', 'run-agent', 'review-proposal',
]);

const ACTION_LABELS = Object.freeze({
  'open-function': { ja: '関数を開く', en: 'Open function' },
  'open-address': { ja: 'この命令へ移動', en: 'Go to instruction' },
  'show-xrefs': { ja: '参照元を見る', en: 'Show xrefs' },
  'show-callers': { ja: '呼び出し元', en: 'Callers' },
  'show-callees': { ja: '呼び出し先', en: 'Callees' },
  'trace-value': { ja: '値を追う', en: 'Trace value' },
  'run-agent': { ja: 'エージェントで調べる', en: 'Investigate with Agent' },
  'review-proposal': { ja: '変更案を確認', en: 'Review proposal' },
});

export function actionLabel(kind, ja = true) {
  const item = ACTION_LABELS[kind];
  return item ? (ja ? item.ja : item.en) : kind;
}

function normalizeAction(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String(raw.kind || '');
  if (!ACTION_KINDS.has(kind)) return null;
  const target = kind === 'run-agent' || kind === 'review-proposal'
    ? text(raw.target, 1000)
    : addressString(raw.target);
  if (kind !== 'run-agent' && !target) return null;
  return {
    id: 'act' + index,
    kind,
    label: text(raw.label, 240) || actionLabel(kind),
    target: target || null,
    address: kind === 'run-agent' || kind === 'review-proposal' ? null : addressBigInt(target),
    evidenceId: raw.evidenceId ? String(raw.evidenceId) : null,
  };
}

function normalizeEvidence(raw, index) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    return {
      id: 'ev' + index, status: STATUS.UNKNOWN, kind: 'observation', title: text(raw, 200),
      summary: '', address: null, functionAddress: null, functionName: null,
      sourceTool: null, confidence: null, code: '',
    };
  }
  const status = normalizeStatus(raw.status, raw.confidence);
  const address = addressString(raw.address ?? raw.navigation?.address);
  const functionAddress = addressString(raw.functionAddress);
  return {
    id: String(raw.id || 'ev' + index),
    status,
    kind: text(raw.kind || 'observation', 60),
    title: text(raw.title || raw.kind || 'evidence', 200),
    summary: text(raw.summary || '', 600),
    address,
    addressValue: addressBigInt(address),
    functionAddress,
    functionAddressValue: addressBigInt(functionAddress),
    functionName: raw.functionName ? text(raw.functionName, 200) : null,
    sourceTool: raw.sourceTool ? text(raw.sourceTool, 80) : null,
    confidence: num(raw.confidence),
    code: text(raw.code || raw.instruction || '', 200),
  };
}

function normalizeHypothesis(raw, index, evidenceById) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    return { id: 'hyp' + index, claim: text(raw, 300), status: STATUS.HYPOTHESIS, confidence: null, support: [], contradictions: [], missing: [] };
  }
  const support = (Array.isArray(raw.supportEvidenceIds) ? raw.supportEvidenceIds : []).map(String);
  const contradictions = (Array.isArray(raw.contradictionEvidenceIds) ? raw.contradictionEvidenceIds : []).map(String);
  return {
    id: String(raw.id || 'hyp' + index),
    claim: text(raw.claim || raw.title || '', 600),
    status: normalizeStatus(raw.status, raw.confidence),
    confidence: num(raw.confidence),
    support: support.map((id) => evidenceById.get(id) || { id, title: id, status: STATUS.UNKNOWN, unresolved: true }).filter((item) => !item.unresolved),
    contradictions: contradictions.map((id) => evidenceById.get(id) || { id, title: id, status: STATUS.UNKNOWN, unresolved: true }).filter((item) => !item.unresolved),
    unresolvedEvidenceIds: [...support, ...contradictions].filter((id) => !evidenceById.has(id)),
    missing: (Array.isArray(raw.missingEvidence) ? raw.missingEvidence : []).map((item) => text(item, 200)).slice(0, 8),
  };
}

function normalizeActivity(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (!raw) continue;
    const item = typeof raw === 'string' ? { label: raw } : raw;
    const label = text(item.label || item.type || '', 160);
    if (!label) continue;
    out.push({
      id: 'ac' + out.length,
      type: text(item.type || 'step', 40),
      label,
      detail: item.count != null ? String(item.count) : text(item.detail || '', 120),
      error: item.errorType ? text(item.errorType, 60) : null,
    });
  }
  return out.slice(-40);
}

/**
 * Raw AI result (any schema version) -> the model every renderer consumes.
 * Unknown top-level fields land in `unknownFields`: a schema addition shows
 * up in a test instead of vanishing.
 */
export function normalizeResponse(raw, fallback = {}) {
  const source = raw && typeof raw === 'object' ? raw : { answer: text(raw) };
  const unknownFields = Object.keys(source).filter((key) => !KNOWN_FIELDS.has(key));
  const answerText = typeof source.answer === 'string' ? source.answer : text(source.answer && (source.answer.text || source.answer.summary) || '');
  const confidence = num(source.confidence);
  const evidence = (Array.isArray(source.evidence) ? source.evidence : []).map(normalizeEvidence).filter(Boolean);
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));

  return {
    mode: source.mode === 'agent' ? 'agent' : (source.mode === 'chat' ? 'chat' : (fallback.mode || 'chat')),
    style: source.style === 'analyst' ? 'analyst' : (source.style === 'beginner' ? 'beginner' : (fallback.style || 'beginner')),
    answerText,
    answer: parseAnswer(answerText),
    confidence,
    verdict: confidence == null ? null : normalizeStatus(null, confidence),
    evidence,
    hypotheses: (Array.isArray(source.hypotheses) ? source.hypotheses : [])
      .map((item, index) => normalizeHypothesis(item, index, evidenceById)).filter((item) => item && item.claim),
    actions: (Array.isArray(source.actions) ? source.actions : []).map(normalizeAction).filter(Boolean).slice(0, 8),
    followups: (Array.isArray(source.followups) ? source.followups : [])
      .map((item) => text(typeof item === 'string' ? item : (item && item.label) || '', 160)).filter(Boolean).slice(0, 6),
    activity: normalizeActivity(source.activity),
    usage: source.usage && typeof source.usage === 'object' ? source.usage : null,
    limits: source.limits && typeof source.limits === 'object' ? source.limits : null,
    sessionId: source.sessionId ? String(source.sessionId) : null,
    error: source.error ? text(source.error, 400) : null,
    unknownFields,
  };
}

/**
 * One confidence scale.
 *
 * A percentage is shown only for a probability produced by evidence fusion.
 * A model-reported or rank-derived score gets stars and a verdict word,
 * because a ranking score is not a probability.
 */
export function confidenceDisplay({ confidence = null, probability = null, status = null } = {}) {
  const resolved = status ? normalizeStatus(status, confidence) : (confidence == null ? null : normalizeStatus(null, confidence));
  if (resolved == null && probability == null) return null;
  const p = num(probability);
  const score = p != null ? p : (num(confidence) || 0);
  return {
    status: resolved || STATUS.UNKNOWN,
    stars: starsOf(score, resolved === STATUS.VERIFIED ? 'confirmed' : ''),
    percent: p == null ? null : Math.round(p * 100),
  };
}

export default normalizeResponse;
