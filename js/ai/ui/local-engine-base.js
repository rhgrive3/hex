/*
 * Fallback engine.
 *
 * The AI core drives the assistant whenever it is available. This module is
 * what answers when it is not: no core build, no network, or a provider error
 * mid-turn. It never fabricates — every fact it prints comes from the same
 * deterministic Hex analysis the rest of the app uses — so a degraded session
 * is still a usable one instead of an apology.
 *
 * Chat  : bounded local context, prose from /api/gemini when reachable.
 * Agent : deterministic goal planner (js/query/planner.js) with live activity.
 */
import { runDeterministicAgent } from '../../agent/runtime.js';
import { streamGemini } from '../../gemini.js';
import { addrHex } from '../../format.js';
import { pick } from '../../i18n.js';
import { compactGuidance, composePrompt } from '../prompts/compose.js';
import { analyzeModelAt } from './hex-context.js';

const MAX_ASSEMBLY_LINES = 240;

function assemblyText(model) {
  const rows = (model && model.instructions) || [];
  return rows.slice(0, MAX_ASSEMBLY_LINES)
    .map((item) => [addrHex(item.address), item.mnemonic, item.operands].filter(Boolean).join(' '))
    .join('\n');
}

function evidenceFromModel(model, addr, name) {
  const out = [];
  if (!model) return out;
  const address = addr == null ? null : addrHex(addr);
  out.push({
    id: 'local:boundary:' + address,
    kind: 'function-boundary',
    status: 'verified',
    title: pick('関数の範囲', 'Function boundary'),
    summary: (model.instructions || []).length + pick(' 命令', ' instructions'),
    functionAddress: address,
    functionName: name,
    sourceTool: 'hex-disassembler',
  });
  const stores = (model.instructions || []).filter((item) => /^str/i.test(item.mnemonic || ''));
  for (const store of stores.slice(0, 4)) {
    out.push({
      id: 'local:store:' + addrHex(store.address),
      kind: 'field-write',
      status: 'supported',
      title: pick('メモリへの書き込み', 'Memory write'),
      summary: [store.mnemonic, store.operands].filter(Boolean).join(' '),
      address: addrHex(store.address),
      functionAddress: address,
      functionName: name,
      sourceTool: 'hex-disassembler',
    });
  }
  return out;
}

function localChatAnswer({ name, address, model, selection }) {
  const lines = [];
  if (selection && selection.text) {
    lines.push(pick(
      `選択中の命令は ${selection.address} の \`${selection.text}\` です。`,
      `The selected instruction is \`${selection.text}\` at ${selection.address}.`));
  }
  if (model) {
    const count = (model.instructions || []).length;
    const blocks = (model.blocks || []).length;
    const calls = (model.instructions || []).filter((item) => /^bl$/i.test(item.mnemonic || '')).length;
    const parts = [pick(`${count} 命令`, `${count} instructions`)];
    if (blocks > 1) parts.push(pick(`${blocks} ブロック`, `${blocks} blocks`));
    if (calls) parts.push(pick(`他の関数を ${calls} 箇所から呼び出し`, `${calls} calls to other functions`));
    lines.push(pick(
      `${name}（${address}）は ${parts.join('・')}です。`,
      `${name} (${address}): ${parts.join(', ')}.`));
  }
  lines.push(pick(
    'AI 応答サービスに接続できないため、ここまでは Hex がバイナリから直接確認した事実だけです。解釈は付けていません。',
    'The AI service is unreachable, so this is only what Hex read directly from the binary — no interpretation was added.'));
  return lines.join('\n\n');
}

async function runChat({ app, question, mode, style, scope, context, signal, onActivity, onText }) {
  const fn = context.function || null;
  const addr = fn ? fn.addressValue : null;
  onActivity({ label: pick('現在の関数を読み込み', 'Loading current function'), state: 'running' });
  const model = addr == null ? null : await analyzeModelAt(app, addr);
  const name = fn ? fn.name : pick('この関数', 'this function');
  const address = fn ? fn.address : '—';
  onActivity({
    label: pick('現在の関数を読み込み', 'Loading current function'),
    detail: model ? (model.instructions || []).length + pick(' 命令', ' instructions') : pick('解析できません', 'unavailable'),
  });

  const prompt = composePrompt({ mode, style, scope, question, context });
  const assembly = assemblyText(model);
  const evidence = evidenceFromModel(model, addr, fn ? fn.name : null);
  const base = {
    mode, style, confidence: null, evidence,
    actions: addr == null ? [] : [{ kind: 'open-function', target: addrHex(addr), label: pick('関数を開く', 'Open function') }],
    followups: [],
  };

  if (!assembly) {
    return { ...base, answer: localChatAnswer({ name, address, model, selection: context.selection }) };
  }

  const payload = {
    question: (compactGuidance(prompt) + '\n\n' + question).slice(0, 6000),
    thinkingLevel: style === 'analyst' ? 'high' : 'medium',
    currentFunction: { address, name: fn ? fn.name : null, assembly, pseudocode: null },
    xrefs: [], callers: [], callees: [], strings: [], globals: [],
  };
  let streamed = '';
  try {
    onActivity({ label: pick('AI に問い合わせ', 'Asking the model'), state: 'running' });
    await streamGemini(payload, {
      onText: (chunk) => { streamed += chunk; if (onText) onText(chunk); },
    }, signal);
    onActivity({ label: pick('AI に問い合わせ', 'Asking the model'), detail: pick('完了', 'done') });
  } catch (error) {
    if (signal && signal.aborted) throw error;
    onActivity({ label: pick('AI に問い合わせ', 'Asking the model'), detail: pick('接続できません', 'unreachable'), state: 'error' });
    return { ...base, answer: localChatAnswer({ name, address, model, selection: context.selection }) };
  }
  return { ...base, answer: streamed.trim() || localChatAnswer({ name, address, model, selection: context.selection }) };
}

function candidateEvidence(plan) {
  const out = [];
  for (const candidate of (plan && plan.candidates) || []) {
    const address = candidate.address == null ? null : addrHex(candidate.address);
    const verified = !!(candidate.verification && candidate.verification.verified);
    out.push({
      id: 'local:candidate:' + address,
      kind: 'candidate',
      status: verified ? 'verified' : 'supported',
      title: (verified ? pick('検証済み候補', 'Verified candidate') : pick('候補', 'Ranked candidate')) + ': ' + (candidate.name || address),
      summary: pick('決定論的スコア ', 'Deterministic score ') + candidate.score
        + ((candidate.sources || []).length ? ' · ' + candidate.sources.slice(0, 4).join(', ') : ''),
      functionAddress: address,
      functionName: candidate.name || null,
      sourceTool: 'deterministic-goal-planner',
      confidence: verified ? 1 : 0.75,
    });
    if (out.length >= 12) break;
  }
  return out;
}

async function runAgent({ app, localContext, question, mode, style, signal, onActivity }) {
  onActivity({ label: pick('索引を準備', 'Preparing indexes'), state: 'running' });
  try { await app.ensureStrings(); } catch { /* the planner copes without strings */ }
  try { await app.ensureProgram(); } catch { /* and without a call graph */ }
  onActivity({
    label: pick('索引を準備', 'Preparing indexes'),
    detail: ((app.stringIndex || []).length) + pick(' 文字列', ' strings'),
  });
  if (signal && signal.aborted) throw new Error('cancelled');

  onActivity({ label: pick('候補を探索', 'Searching candidates'), state: 'running' });
  const started = Date.now();
  const result = await runDeterministicAgent(question, localContext || {}, {
    maxFunctions: 24, maxDisassembly: 40000, timeoutMs: 20000,
    isCancelled: () => !!(signal && signal.aborted),
  });
  const plan = result.plan || {};
  onActivity({
    label: pick('候補を探索', 'Searching candidates'),
    detail: ((plan.candidates || []).length) + pick(' 候補', ' candidates'),
  });
  const best = plan.best || null;
  if (best) {
    onActivity({
      label: pick('検証', 'Verifying'),
      detail: best.verification && best.verification.verified
        ? pick('更新経路を確認', 'update path confirmed')
        : pick('未検証', 'not verified'),
    });
  }

  const address = best && best.address != null ? addrHex(best.address) : null;
  const answer = best
    ? pick(
      `いちばん有力なのは ${best.name || address}（${address}）です。Hex の決定論的な探索が候補を順位付けし、${best.verification && best.verification.verified ? '値の更新経路まで確認できました。' : 'この候補はまだ更新経路を確認できていません。'}`,
      `The strongest candidate is ${best.name || address} (${address}). Hex ranked the candidates deterministically and ${best.verification && best.verification.verified ? 'confirmed the update path.' : 'has not yet confirmed the update path.'}`)
    : pick('この目的に合う関数を、確かな根拠つきでは特定できませんでした。', 'No candidate function could be identified with dependable evidence.');

  const missing = (result.missingEvidence || []).slice(0, 4);
  return {
    mode, style,
    answer,
    confidence: result.confidence,
    evidence: candidateEvidence(plan),
    hypotheses: best ? [{
      id: 'local:hyp:' + address,
      claim: pick(`${best.name || address} が目的の処理を行っている`, `${best.name || address} implements the requested behaviour`),
      confidence: result.confidence,
      status: best.verification && best.verification.verified ? 'verified' : 'supported',
      supportEvidenceIds: [],
      contradictionEvidenceIds: [],
      missingEvidence: missing,
    }] : [],
    actions: address ? [
      { kind: 'open-function', target: address, label: pick('候補関数を開く', 'Open candidate') },
      { kind: 'show-callers', target: address, label: pick('呼び出し元を見る', 'Show callers') },
    ] : [],
    followups: missing,
    usage: { toolCalls: 0, elapsedMs: Date.now() - started, candidateCount: (plan.candidates || []).length },
    activity: [],
  };
}

/**
 * @param {object} app the Hex app
 * @param {object} localContext the shared AI context (also used by the core)
 */
export function createLocalEngine(app, localContext) {
  return {
    id: 'local',
    async run(input) {
      const args = { ...input, app, localContext };
      return input.mode === 'agent' ? runAgent(args) : runChat(args);
    },
  };
}

export default createLocalEngine;
