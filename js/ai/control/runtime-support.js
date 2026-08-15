import { AIError } from '../schema.js';
import { resolveBinaryIdentity } from './snapshot.js';

export function requiredScopeForTool(tool) {
  if (['search_functions','search_strings','compare_functions','lookup_known_function'].includes(tool)) return 'binary';
  if (['project_search','get_binary_diff'].includes(tool)) return 'project';
  if (['get_runtime_observations','verify_runtime_hypothesis'].includes(tool)) return 'runtime';
  if (tool === 'get_related_functions') return 'neighborhood';
  return null;
}
export function wireMeta(request, controller, intent, sessionId = null) { return { sessionId, mode: request.mode, style: request.style, scope: controller.effectiveScope, requestedScope: request.scope, effectiveScope: controller.effectiveScope, intent, task: request.task || null, responseSchema: null }; }
export function maxWireUsage(a, b) { return Object.fromEntries(Object.keys(a).map((key) => [key, Math.max(Number(a[key] || 0), Number(b[key] || 0))])); }
export function memoryAnchor(snapshot, effectiveScope) { return { snapshotId: snapshot.id, binaryId: snapshot.binaryId, functionAddress: snapshot.currentFunction?.address || null, selection: snapshot.selection ? { start: snapshot.selection.start, end: snapshot.selection.end } : null, effectiveScope }; }
export function sessionMatchesSnapshot(session, snapshot) {
  const binaryMatches = session.binaryId == null || session.binaryId === snapshot.binaryId || session.binaryId === snapshot.legacyBinaryId || session.binaryIdentity?.legacyId === snapshot.legacyBinaryId;
  const projectMatches = session.projectId == null || snapshot.projectIdentity == null || String(session.projectId) === String(snapshot.projectIdentity);
  return binaryMatches && projectMatches;
}
export function assertLiveBindingsUnchanged(local, snapshot) {
  const live = resolveBinaryIdentity(local, {});
  const same = live.id === snapshot.binaryIdentity.id || (live.legacyId && snapshot.legacyBinaryId && live.legacyId === snapshot.legacyBinaryId);
  if (!same) throw new AIError('scope_violation', 'The binary changed while this AI turn was running; refusing to mix workbench states.');
  const liveProject = local.projectId ?? local.project?.id ?? local.project?.binaryHash ?? null;
  if (snapshot.projectIdentity != null && liveProject != null && String(liveProject) !== String(snapshot.projectIdentity)) {
    throw new AIError('scope_violation', 'The project changed while this AI turn was running; refusing to mix workbench states.');
  }
  const liveRuntime = local.runtimeSession?.id ?? local.runtime?.sessionId ?? local.runtimeSessionId ?? null;
  if (snapshot.runtimeSessionIdentity != null && liveRuntime != null && String(liveRuntime) !== String(snapshot.runtimeSessionIdentity)) {
    throw new AIError('scope_violation', 'The runtime session changed while this AI turn was running; refusing to mix workbench states.');
  }
}
export function compactCandidate(candidate) { return { address: addressString(candidate.address), name: candidate.name, lexicalScore: candidate.lexicalScore, semanticScore: candidate.semanticScore, graphScore: candidate.graphScore, evidenceScore: candidate.evidenceScore, runtimeScore: candidate.runtimeScore, totalScore: candidate.totalScore, reasons: candidate.reasons }; }
export function deterministicDecision(plan, request, error = null) {
  const best = plan?.best;
  if (best) { const address = addressString(best.address); return { type: 'final', answer: `最も強い候補は ${best.name || address} です。Hex の決定論的 planner が候補を順位付けし、${best.verification?.verified ? '更新経路を検証しました。' : '追加検証が必要です。'}`, confidence: deterministicConfidence(plan), evidenceIds: plan.evidence || [], hypothesisIds: [], suggestedActions: address ? [{ kind: 'open-function', target: address, label: '候補関数を開く' }] : [], followups: plan.missingEvidence || [] }; }
  return { type: 'final', answer: error ? humanError(error) : (request.mode === 'chat' ? '利用できるローカル根拠だけでは回答を確定できませんでした。' : '有力な候補を特定できませんでした。'), confidence: 0, evidenceIds: [], suggestedActions: [], followups: plan?.missingEvidence || [] };
}
export function fallbackEvidence(store, plan) { const planIds = new Set(plan?.evidence || []), exact = store.all().filter((item) => planIds.has(item.id)); if (exact.length) return exact.slice(0, 50); const planned = store.all().filter((item) => item.sourceTool === 'deterministic-goal-planner'); if (planned.length) return planned.slice(-50); return store.all().filter((item) => item.status === 'verified').slice(-50); }
export function deterministicConfidence(plan) { if (plan?.best?.verification?.verified) return 0.98; if (plan?.best?.semanticFacts?.length) return 0.78; return plan?.best ? 0.45 : 0; }
export function presentAnswer(answer, style, evidence, plan) { if (style === 'analyst') return answer; const suffix = evidence.length ? `\n\nHex が確認できた根拠は ${evidence.length} 件です。` : '\n\nこの回答には、Hex が確認済みにした根拠がまだありません。'; return `${answer}${suffix}${plan?.missingEvidence?.length ? ` 次に確認する点: ${plan.missingEvidence.slice(0, 3).join('、')}。` : ''}`; }
export function ensureRunning(signal, started, timeoutMs) { if (signal?.aborted) throw new AIError(signal.reason === 'timeout' ? 'budget_exhausted' : 'cancelled', signal.reason === 'timeout' ? 'The AI investigation timed out.' : 'AI investigation was cancelled.'); if (Date.now() - started >= timeoutMs) throw new AIError('budget_exhausted', 'The AI investigation timed out.'); }
export function remainingTime(started, timeoutMs) { return Math.max(1, timeoutMs - (Date.now() - started)); }
export function normalizeError(error, signal) { if (error instanceof AIError) return error; if (signal?.aborted || error?.name === 'AbortError') return new AIError(signal?.reason === 'timeout' ? 'budget_exhausted' : 'cancelled', signal?.reason === 'timeout' ? 'The AI investigation timed out.' : 'AI investigation was cancelled.'); return new AIError('provider_error', error?.message || String(error)); }
export function humanError(error) { const labels = { cancelled: '解析を停止しました。保存済みの証拠とセッションは保持されています。', budget_exhausted: '解析予算または時間上限に達しました。得られた根拠までを返します。', context_too_large: 'provider へ送る入力全体が安全な上限を超えたため、送信前に停止しました。', model_timeout: 'モデル応答が時間内に完了しませんでした。ローカル解析結果は保持されています。', provider_error: 'AI provider を利用できませんでした。ローカル解析結果は保持されています。', invalid_model_output: 'モデル出力を安全に検証できませんでした。', invalid_tool_call: 'モデルが要求したツール呼び出しを検証できませんでした。', scope_violation: '指定された解析範囲を越える要求を拒否しました。', tool_failed: 'Hex ツールの実行に失敗しました。'}; return labels[error?.type] || error?.message || 'AI 解析を完了できませんでした。'; }
export function addressExistsSync(context, address) { if (typeof context.addressExists === 'function') { const result = context.addressExists(address); if (typeof result === 'boolean') return result; } try { if (context.program?.functionRange) return !!context.program.functionRange(BigInt(address)); if (context.symbols?.functionAt) return !!context.symbols.functionAt(BigInt(address)); } catch { return false; } return true; }
export function stableStringify(value) { if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`; return JSON.stringify(value); }
export function addressString(value) { try { return `0x${BigInt(value).toString(16)}`; } catch { return null; } }
