import { printExpression } from './pretty/c.js';

function uniq(xs) { return [...new Set(xs.filter(Boolean))]; }

function describeStore(s) {
  const lhs = s.lhsText || s.location?.text || s.location?.name || 'memory';
  const rhs = s.expression ? printExpression(s.expression) : 'value';
  if (s.readModifyWrite?.kind === 'clamp-zero-sub') return `${lhs}から${s.readModifyWrite.operand || '値'}を引き、0未満にならないよう制限して同じ場所へ保存しています。`;
  if (s.readModifyWrite?.kind === 'add') return `${lhs}へ${s.readModifyWrite.operand || '値'}を加えて保存しています。`;
  return `${lhs}へ${rhs}を保存しています。`;
}

export function explainSemanticFacts(facts, fallbackSummary = null) {
  const inputs = uniq((facts?.inputs || []).map((x) => x.name || x));
  const outputs = uniq((facts?.outputs || []).map((x) => x.name || x));
  const sideEffects = [];
  for (const s of facts?.stores || []) sideEffects.push(`write ${s.lhsText || s.location?.key || 'memory'}`);
  for (const c of facts?.calls || []) sideEffects.push(`call ${c.name || 'unknown'}`);
  const conditions = (facts?.conditions || []).map((c) => c.text || (c.expression ? printExpression(c.expression) : 'condition'));
  let summary = fallbackSummary || null;
  if (facts?.stores?.length === 1 && !(facts?.calls?.length)) summary = describeStore(facts.stores[0]);
  else if (facts?.calls?.some((c) => c.runtime === 'objc')) summary = 'Objective-Cのメッセージ送信を、復元できたreceiver・selector・引数情報付きで実行しています。';
  else if (facts?.calls?.some((c) => c.runtime === 'swift')) summary = 'Swiftの呼び出しを、復元できたABI・型・dispatch情報を保った疑似Cとして表示しています。';
  else if (!summary) summary = 'Semantic IRのdef-use・Memory SSA・制御フローから確認できた処理を疑似Cへ復元しています。';
  return {
    summary,
    importantInputs: inputs,
    importantOutputs: outputs,
    sideEffects: uniq(sideEffects),
    conditions: uniq(conditions),
    warnings: facts?.warnings || [],
    evidence: facts?.evidence || [],
  };
}
