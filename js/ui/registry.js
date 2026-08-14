/* Canonical product information architecture. Keep this file pure/testable. */

export const ROUTES = Object.freeze([
  { id: 'investigate', pattern: '/investigate', title: '調べる', kind: 'screen', primary: true },
  { id: 'code', pattern: '/code/:address?', title: 'コード', kind: 'screen', primary: true },
  { id: 'explorer', pattern: '/explorer/:scope?', title: '索引', kind: 'screen', primary: true },
  { id: 'results', pattern: '/results', title: '結果', kind: 'screen', primary: true },
  { id: 'function', pattern: '/function/:address/:tab?', title: '関数', kind: 'workspace' },
  { id: 'finding', pattern: '/finding/:id', title: '結果', kind: 'screen' },
  { id: 'settings', pattern: '/settings', title: '設定', kind: 'screen' },
  { id: 'help', pattern: '/help', title: 'ヘルプ', kind: 'screen' },
  { id: 'learn', pattern: '/learn', title: '学ぶ', kind: 'screen' },
  { id: 'advanced', pattern: '/advanced', title: '高度な機能', kind: 'screen' },
]);

export const PRIMARY_NAV = Object.freeze([
  { route: '/investigate', routeId: 'investigate', label: '調べる', icon: '⌕' },
  { route: '/code', routeId: 'code', label: 'コード', icon: '⌘' },
  { route: '/explorer/functions', routeId: 'explorer', label: '索引', icon: '☷' },
  { route: '/results', routeId: 'results', label: '結果', icon: '✓' },
]);

export const EXPLORER_SCOPES = Object.freeze([
  { id: 'functions', label: '関数', beginner: true },
  { id: 'strings', label: '文字列', beginner: true },
  { id: 'classes', label: '型 / クラス', beginner: true },
  { id: 'data', label: 'データ', beginner: false },
  { id: 'external', label: '外部API', beginner: false },
  { id: 'sections', label: 'セクション', beginner: false },
]);

export const FUNCTION_TABS = Object.freeze([
  { id: 'overview', label: '概要' },
  { id: 'pseudocode', label: '疑似C' },
  { id: 'flow', label: 'フロー' },
  { id: 'calls', label: '呼び出し' },
  { id: 'evidence', label: '根拠' },
  { id: 'runtime', label: '実行' },
]);

export const LEGACY_MIGRATION = Object.freeze({
  showOverview: 'merge:/investigate',
  showInvestigate: 'merge:/investigate',
  showFeatures: 'merge:/investigate strategy',
  showSearch: 'merge:global command + explorer',
  showJump: 'merge:global command',
  showFunctions: 'merge:/explorer/functions',
  showStrings: 'merge:/explorer/strings',
  showSections: 'merge:/explorer/sections',
  showStructure: 'merge:/explorer',
  showFunctionSummary: 'merge:/function/:address/overview',
  showFunctionReport: 'merge:/function/:address/overview',
  showDecompiler: 'merge:/function/:address/pseudocode',
  showCfg: 'merge:/function/:address/flow',
  showCallGraphPanel: 'merge:/function/:address/calls',
  showTypes: 'merge:/function/:address/overview',
  showDebugger: 'merge:/function/:address/runtime',
  showAccuracyNotes: 'merge:/function/:address/evidence + /results',
  showFileInfo: 'redirect:/advanced',
  showSettings: 'redirect:/settings',
  showHelp: 'redirect:/help',
  showLearn: 'redirect:/learn',
  showTools: 'merge:/advanced + contextual actions',
});

export function createActionRegistry() {
  const actions = new Map();
  return {
    register(id, action) {
      if (!id || typeof action !== 'function') throw new TypeError('action requires id and function');
      if (actions.has(id)) throw new Error('duplicate action: ' + id);
      actions.set(id, action);
      return action;
    },
    run(id, ...args) {
      const action = actions.get(id);
      if (!action) throw new Error('unknown action: ' + id);
      return action(...args);
    },
    has(id) { return actions.has(id); },
    ids() { return Array.from(actions.keys()); },
  };
}
