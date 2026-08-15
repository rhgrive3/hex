/*
 * Response normalization: the boundary between the AI core's schema and the
 * renderers. Forward compatibility is the point — a field this build does not
 * know must be reported, never silently dropped or rendered as junk.
 */
import assert from 'node:assert/strict';
import {
  normalizeResponse, normalizeStatus, parseAnswer, confidenceDisplay,
  addressString, statusText, statusMark, actionLabel, STATUS,
} from '../js/ai/render/normalize.js';
import { collapseActivity } from '../js/ai/render/activity.js';

/*
 * The vocabulary lists come from the AI core when that build is present, so
 * this file fails the day the core adds a status or an action kind the UI
 * cannot render. Without the core (UI-only checkout) the documented contract
 * is used instead — the point of the check is unchanged.
 */
const core = await import('../js/ai/schema.js').catch(() => null);
const EVIDENCE_STATUSES = core?.EVIDENCE_STATUSES || ['verified', 'supported', 'hypothesis', 'unknown'];
const AI_ACTION_KINDS = core?.AI_ACTION_KINDS || [
  'open-function', 'open-address', 'show-xrefs', 'show-callers', 'show-callees',
  'trace-value', 'run-agent', 'review-proposal',
];

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('ok    ' + name); }
  catch (error) { failures++; console.log('FAIL  ' + name + ' — ' + (error && error.message)); }
}

const coreResult = {
  mode: 'agent',
  style: 'analyst',
  answer: 'sub_100458B20 が XP を更新しています。\n\n- `STR W1, [X0,#0xC030]`\n- 呼び出し元は報酬処理',
  confidence: 0.94,
  evidence: [
    {
      id: 'ev_a', kind: 'field-write', status: 'verified', title: 'verify_field_update: updates',
      summary: 'read-modify-write on field 0xC030', address: '0x100458c10', functionAddress: '0x100458b20',
      functionName: 'sub_100458B20', sourceTool: 'verify_field_update', confidence: 1,
      navigation: { address: '0x100458c10' },
    },
    { id: 'ev_b', kind: 'candidate', status: 'supported', title: 'Ranked candidate', functionAddress: '0x100458b20' },
  ],
  hypotheses: [{
    id: 'hyp_1', claim: 'XP update handler', confidence: 0.87, status: 'supported',
    supportEvidenceIds: ['ev_a'], contradictionEvidenceIds: [], missingEvidence: ['persistence path not verified'],
  }],
  actions: [
    { kind: 'open-function', target: '0x100458b20', label: '関数を開く' },
    { kind: 'show-callers', target: '0x100458b20' },
  ],
  followups: ['セーブ経路を確認する'],
  activity: [{ type: 'plan-start', label: '候補探索' }, { type: 'candidate-update', label: '候補を絞り込み', count: 6 }],
  usage: { toolCalls: 4, elapsedMs: 2300 },
  limits: { exhausted: false },
  sessionId: 'ai_x1',
};

check('a core result normalizes without loss', () => {
  const model = normalizeResponse(coreResult);
  assert.equal(model.mode, 'agent');
  assert.equal(model.style, 'analyst');
  assert.equal(model.confidence, 0.94);
  assert.equal(model.evidence.length, 2);
  assert.equal(model.evidence[0].status, STATUS.VERIFIED);
  assert.equal(model.evidence[0].addressValue, 0x100458c10n);
  assert.equal(model.hypotheses[0].support[0].id, 'ev_a');
  assert.equal(model.actions.length, 2);
  assert.equal(model.actions[1].label, actionLabel('show-callers'));
  assert.equal(model.followups.length, 1);
  assert.equal(model.activity[1].detail, '6');
  assert.equal(model.sessionId, 'ai_x1');
  assert.deepEqual(model.unknownFields, []);
});

check('unknown top-level fields are reported, not dropped in silence', () => {
  const model = normalizeResponse({ ...coreResult, telemetry: { x: 1 }, nextProtocol: 'v2' });
  assert.deepEqual(model.unknownFields.sort(), ['nextProtocol', 'telemetry']);
  assert.equal(model.answerText, coreResult.answer, 'known fields still render');
});

check('every status the core can emit maps to a UI state with a word and a glyph', () => {
  for (const status of EVIDENCE_STATUSES) {
    const mapped = normalizeStatus(status);
    assert.ok(Object.values(STATUS).includes(mapped), status);
    assert.ok(statusText(mapped, true).length > 0);
    assert.ok(statusText(mapped, false).length > 0);
    assert.ok(statusMark(mapped).length > 0, 'state must be readable without colour');
  }
  assert.equal(normalizeStatus('rejected'), STATUS.CONTRADICTED);
  assert.equal(normalizeStatus('something-new'), STATUS.UNKNOWN);
  assert.equal(normalizeStatus(null, 0.99), STATUS.SUPPORTED);
  assert.equal(normalizeStatus(null, 0.8), STATUS.SUPPORTED);
  assert.equal(normalizeStatus('verified', 0.2), STATUS.VERIFIED, 'verification requires explicit provenance/status');
});

check('every action kind the core can emit is renderable', () => {
  for (const kind of AI_ACTION_KINDS) {
    const target = kind === 'run-agent' ? 'find the save path' : kind === 'review-proposal' ? 'proposal_1' : '0x1000';
    const model = normalizeResponse({ answer: 'a', actions: [{ kind, target }] });
    assert.equal(model.actions.length, 1, kind);
    assert.ok(model.actions[0].label.length > 0, kind);
  }
});

check('an unknown or unaddressed action is refused rather than rendered dead', () => {
  const model = normalizeResponse({ answer: 'a', actions: [
    { kind: 'delete-everything', target: '0x1000' },
    { kind: 'open-function' },
    { kind: 'open-function', target: 'not-an-address' },
  ] });
  assert.equal(model.actions.length, 0);
});

check('evidence and hypotheses survive a schema that only sends strings', () => {
  const model = normalizeResponse({ answer: 'a', evidence: ['ir:0x10'], hypotheses: ['maybe this one'] });
  assert.equal(model.evidence[0].title, 'ir:0x10');
  assert.equal(model.evidence[0].status, STATUS.UNKNOWN);
  assert.equal(model.hypotheses[0].claim, 'maybe this one');
});

check('a non-object response still produces an answer', () => {
  const model = normalizeResponse('plain text answer');
  assert.equal(model.answerText, 'plain text answer');
  assert.equal(model.answer[0].type, 'p');
});

check('answer prose parses into blocks without executing markup', () => {
  const blocks = parseAnswer('# 結論\n\nsub_1 が **XP** を書きます。\n\n- `STR W1`\n- 2 callers\n\n```\nldr w8, [x0]\n```');
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'p', 'bullets', 'code']);
  assert.equal(blocks[2].items.length, 2);
  assert.ok(blocks[1].segments.some((segment) => segment.t === 'strong' && segment.v === 'XP'));
  const html = parseAnswer('<img src=x onerror=alert(1)>');
  assert.equal(html[0].segments[0].v, '<img src=x onerror=alert(1)>', 'markup stays literal text');
});

check('a percentage is shown only for a fused probability', () => {
  const model = confidenceDisplay({ confidence: 0.87, status: 'supported' });
  assert.equal(model.percent, null, 'a model score is not a probability');
  assert.ok(model.stars >= 1 && model.stars <= 5);
  const fused = confidenceDisplay({ probability: 0.94, status: 'verified' });
  assert.equal(fused.percent, 94);
  assert.equal(fused.stars, 5);
  assert.equal(confidenceDisplay({}), null);
});

check('addresses normalize to one canonical form', () => {
  assert.equal(addressString('0x100458C00'), '0x100458c00');
  assert.equal(addressString(4096), '0x1000');
  assert.equal(addressString(4096n), '0x1000');
  assert.equal(addressString('sub_1'), null);
  assert.equal(addressString(null), null);
});

check('repeated activity labels collapse into one row', () => {
  const collapsed = collapseActivity([
    { label: 'Searching strings', detail: '3' },
    { label: 'Searching strings', detail: '13' },
    { label: 'Following xrefs', detail: '6' },
  ]);
  assert.equal(collapsed.length, 2);
  assert.equal(collapsed[0].detail, '13');
});

check('a large evidence list is carried whole but stays addressable', () => {
  const evidence = Array.from({ length: 120 }, (_, i) => ({ id: 'ev' + i, status: 'supported', title: 'item ' + i, functionAddress: '0x' + (0x1000 + i).toString(16) }));
  const model = normalizeResponse({ answer: 'a', evidence });
  assert.equal(model.evidence.length, 120);
  assert.equal(model.evidence[119].functionAddressValue, BigInt(0x1000 + 119));
});

check('an error result keeps its message', () => {
  const model = normalizeResponse({ answer: '', error: 'budget_exhausted' });
  assert.equal(model.error, 'budget_exhausted');
});

console.log(failures ? `\n${failures} failed` : '\nai-ui-evidence: PASS');
if (failures) process.exit(1);
