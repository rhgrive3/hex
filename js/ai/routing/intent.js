const RULES = [
  ['runtime-verify', /(runtime|debug|実行時|動的|ブレークポイント|検証して|verify.*runtime)/i],
  ['compare', /(compare|difference|diff|比較|違い|差分)/i],
  ['project-query', /(project|annotation|comment|rename|プロジェクト|注釈|メモ)/i],
  ['trace-value', /(trace|data.?flow|value of|register|\bx\d+\b|\bw\d+\b|レジスタ|値.*どこ|由来|追跡)/i],
  ['explain-selection', /(selection|selected|this instruction|この命令|選択|選んだ|ハイライト)/i],
  ['find-behaviour', /(where|locate|find|探|特定).*(increase|decrease|write|update|behavio|処理|増|減|書き|更新|変更)/i],
  ['find-function', /(find|locate|search|探|特定).*(function|method|関数|メソッド)/i],
  ['explain-current-function', /(this function|current function|この関数|今の関数|what does.*function|関数.*何|関数.*説明)/i],
];

export function routeIntent(goal, snapshot = {}) {
  const text = String(goal || '').trim();
  for (const [intent, pattern] of RULES) if (pattern.test(text)) return intent;
  if (snapshot.selection && /(what|why|how|意味|何|なぜ|どう)/i.test(text)) return 'explain-selection';
  if (snapshot.currentFunction && /(what|why|how|意味|何|なぜ|どう)/i.test(text)) return 'explain-current-function';
  if (/^(what|why|how|is |are |can |does |explain|教えて|とは|なぜ|どう)/i.test(text)) return 'general-question';
  return 'unknown';
}

export function shouldRunPlanner(request = {}, snapshot = {}, intent = routeIntent(request.goal, snapshot)) {
  if (request.mode !== 'agent') return false;
  if (request.planner === false) return false;
  return intent === 'find-behaviour' || intent === 'find-function';
}
