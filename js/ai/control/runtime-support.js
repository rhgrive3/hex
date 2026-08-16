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
export function memoryAnchor(snapshot, effectiveScope, liveContext = null) {
  let runtimeSessionId = snapshot.runtimeSessionIdentity || null;
  let runtimeSessionState = snapshot.runtimeSessionState || (runtimeSessionId != null ? 'bound' : 'unknown');
  // A runtime session can be created lazily by the first runtime tool in a
  // turn. After the immutable snapshot has protected the turn, promote that
  // observed binding into structured memory so the next user turn can enforce
  // the exact session identity.
  if (runtimeSessionState === 'unknown' && liveContext?.runtimeSessionKnown === true) {
    const observed = liveContext.runtimeSession?.id ?? liveContext.runtime?.sessionId ?? liveContext.runtimeSessionId ?? null;
    runtimeSessionId = observed == null ? null : String(observed);
    runtimeSessionState = runtimeSessionId == null ? 'none' : 'bound';
  }
  return { snapshotId: snapshot.id, binaryId: snapshot.binaryId, functionAddress: snapshot.currentFunction?.address || null, selection: snapshot.selection ? { start: snapshot.selection.start, end: snapshot.selection.end } : null, runtimeSessionId, runtimeSessionState, effectiveScope };
}
export function sessionMatchesSnapshot(session, snapshot) {
  const sessionIdentity = session.binaryIdentity || null;
  const snapshotIdentity = snapshot.binaryIdentity || null;
  const sessionId = session.binaryId ?? sessionIdentity?.id ?? null;
  const snapshotId = snapshot.binaryId ?? snapshotIdentity?.id ?? null;
  const sessionBindingId = sessionId == null ? null : String(sessionId);
  const snapshotBindingId = snapshotId == null ? null : String(snapshotId);
  let binaryMatches = sessionBindingId == null || sessionBindingId === snapshotBindingId;
  if (!binaryMatches) {
    const sessionStrong = strongIdentity(sessionIdentity, sessionBindingId);
    const snapshotStrong = strongIdentity(snapshotIdentity, snapshotBindingId);
    const sessionLegacy = sessionIdentity?.legacyId ?? (!sessionIdentity ? sessionBindingId : null);
    const snapshotLegacy = snapshot.legacyBinaryId ?? snapshotIdentity?.legacyId ?? null;

    // Backward compatibility: an old session that only stored filename:slice,
    // or a weak pre-hash session, may be upgraded to a strong current binding.
    // Never use a shared legacy name to equate two different strong identities,
    // and never downgrade a strong stored binding to an unverifiable weak one.
    if (!sessionStrong && snapshotStrong) binaryMatches = sameLegacy(sessionLegacy, snapshotLegacy);
    else if (!sessionStrong && !snapshotStrong) binaryMatches = sameLegacy(sessionLegacy, snapshotLegacy);
    else binaryMatches = false;
  }
  const projectMatches = session.projectId == null || (snapshot.projectIdentity != null && String(session.projectId) === String(snapshot.projectIdentity));
  const priorAnchor = session.investigationMemory?.anchor || null;
  const priorRuntime = priorAnchor?.runtimeSessionId ?? null;
  const priorRuntimeState = priorAnchor?.runtimeSessionState || (priorRuntime != null ? 'bound' : 'unknown');
  const snapshotRuntimeState = snapshot.runtimeSessionState || (snapshot.runtimeSessionIdentity != null ? 'bound' : 'unknown');
  let runtimeMatches = true;
  if (priorRuntimeState === 'bound') runtimeMatches = snapshotRuntimeState === 'bound' && String(priorRuntime) === String(snapshot.runtimeSessionIdentity);
  else if (priorRuntimeState === 'none') runtimeMatches = snapshotRuntimeState === 'none';
  return binaryMatches && projectMatches && runtimeMatches;
}
export function assertLiveBindingsUnchanged(local, snapshot) {
  const live = resolveBinaryIdentity(local, {});
  const snapshotIdentity = snapshot.binaryIdentity || null;
  const sameId = live.id === snapshotIdentity?.id;
  const bothWeak = !strongIdentity(live, live.id) && !strongIdentity(snapshotIdentity, snapshot.binaryId);
  const same = sameId || (bothWeak && sameLegacy(live.legacyId, snapshot.legacyBinaryId));
  if (!same) throw new AIError('scope_violation', 'The binary changed while this AI turn was running; refusing to mix workbench states.');
  const liveProject = local.projectId ?? local.project?.id ?? local.project?.binaryHash ?? null;
  if (!sameNullableBinding(liveProject, snapshot.projectIdentity)) {
    throw new AIError('scope_violation', 'The project changed while this AI turn was running; refusing to mix workbench states.');
  }
  const liveRuntime = local.runtimeSession?.id ?? local.runtime?.sessionId ?? local.runtimeSessionId ?? null;
  const liveRuntimeKnown = local.runtimeSessionKnown === true || liveRuntime != null;
  const liveRuntimeState = liveRuntimeKnown ? (liveRuntime == null ? 'none' : 'bound') : 'unknown';
  const snapshotRuntimeState = snapshot.runtimeSessionState || (snapshot.runtimeSessionIdentity != null ? 'bound' : 'unknown');
  // An unknown runtime binding is intentionally permissive for this turn: the
  // first runtime-verification tool may lazily create the session. Once a
  // concrete session has been observed, subsequent turns snapshot and enforce
  // that exact ID. A known binding may never disappear or change mid-turn.
  if (snapshotRuntimeState === 'bound') {
    if (liveRuntimeState !== 'bound' || String(liveRuntime) !== String(snapshot.runtimeSessionIdentity)) {
      throw new AIError('scope_violation', 'The runtime session changed while this AI turn was running; refusing to mix workbench states.');
    }
  } else if (snapshotRuntimeState === 'none' && liveRuntimeState !== 'none') {
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
export function normalizeError(error, signal) { if (error instanceof AIError) return error; if (signal?.aborted || error?.name === 'AbortError') return new AIError(signal?.reason === 'timeout' ? 'budget_exhausted' : 'cancelled', signal?.reason === 'timeout' ? 'The AI investigation timed out.' : 'AI investigation was cancelled.'); return new AIError('provider_error', error?.message || String(error), providerDiagnostics(error)); }
/*
 * A provider failure must never lose the subtype that explains it. The friendly
 * label stays unchanged for beginners; these fields are the developer-visible
 * record of which provider, which bridge guard, and which deployed runtime
 * produced the failure. Only closed-vocabulary tokens are carried, so no DOM,
 * prompt or storage text can leak into activity or telemetry.
 */
export function providerDiagnostics(error) { const details = error instanceof AIError ? error.details : error; const provider = safeDiagnosticToken(details?.provider, /^[a-z][a-z0-9-]{0,63}$/); const bridgeCode = safeDiagnosticToken(details?.bridgeCode ?? error?.code, /^[A-Za-z0-9_.-]{1,64}$/); const bridgeStage = safeDiagnosticToken(details?.bridgeStage ?? error?.stage, /^[a-z][a-z0-9-]{0,63}$/); const runtimeBuildId = safeDiagnosticToken(details?.runtimeBuildId, /^[a-f0-9]{1,64}$/i); const out = {}; if (provider) out.provider = provider; if (bridgeCode) out.bridgeCode = bridgeCode; if (bridgeStage) out.bridgeStage = bridgeStage; if (runtimeBuildId) out.runtimeBuildId = runtimeBuildId; return Object.keys(out).length ? out : null; }
function safeDiagnosticToken(value, pattern) { return typeof value === 'string' && pattern.test(value) ? value : null; }
export function humanError(error) { const labels = { cancelled: '解析を停止しました。保存済みの証拠とセッションは保持されています。', budget_exhausted: '解析予算または時間上限に達しました。得られた根拠までを返します。', context_too_large: 'provider へ送る入力全体が安全な上限を超えたため、送信前に停止しました。', model_timeout: 'モデル応答が時間内に完了しませんでした。ローカル解析結果は保持されています。', provider_error: 'AI provider を利用できませんでした。ローカル解析結果は保持されています。', invalid_model_output: 'モデル出力を安全に検証できませんでした。', invalid_tool_call: 'モデルが要求したツール呼び出しを検証できませんでした。', scope_violation: '指定された解析範囲を越える要求を拒否しました。', tool_failed: 'Hex ツールの実行に失敗しました。'}; return labels[error?.type] || error?.message || 'AI 解析を完了できませんでした。'; }
export function addressExistsSync(context, address) { if (typeof context.addressExists === 'function') { const result = context.addressExists(address); if (typeof result === 'boolean') return result; } try { if (context.program?.functionRange) return !!context.program.functionRange(BigInt(address)); if (context.symbols?.functionAt) return !!context.symbols.functionAt(BigInt(address)); } catch { return false; } return true; }
export function stableStringify(value) { if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`; return JSON.stringify(value); }
export function addressString(value) { try { return `0x${BigInt(value).toString(16)}`; } catch { return null; } }

function strongIdentity(identity, id) {
  const value = id == null ? identity?.id : id;
  if (identity?.hash != null && String(identity.hash)) return true;
  if (typeof value === 'string' && value.startsWith('content:')) return true;
  return identity?.confidence === 'strong' && identity?.state === 'ready' && typeof value === 'string' && !value.startsWith('fallback:');
}
function sameLegacy(a, b) { return a != null && b != null && String(a) === String(b); }
function sameNullableBinding(a, b) { return a == null && b == null || a != null && b != null && String(a) === String(b); }
