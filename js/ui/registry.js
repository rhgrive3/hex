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

/* Every exported legacy show* entrypoint in panels.js/tools.js has one disposition. */
export const LEGACY_MIGRATION = Object.freeze({
  showFileInfo: 'redirect:/advanced',
  showSections: 'merge:/explorer/sections',
  showStructure: 'merge:/explorer/data + /advanced',
  showFunctions: 'merge:/explorer/functions',
  showFunctionSummary: 'merge:/function/:address/overview',
  showBlockDetail: 'merge:/function/:address/flow + code inspector',
  showFeatures: 'merge:/investigate strategy',
  showStrings: 'merge:/explorer/strings',
  showJump: 'merge:global command',
  showSearch: 'merge:global command + /explorer',
  showXrefs: 'merge:/function/:address/calls + code inspector',
  showDetail: 'merge:code inspector',
  showOverview: 'merge:/investigate',
  showAppMap: 'merge:/results + /explorer/classes',
  showSubsystem: 'merge:/explorer/classes',
  showClass: 'merge:/explorer/classes',
  showField: 'merge:/explorer/data + /function/:address/evidence',
  showPinned: 'merge:/results + /finding/:id',
  showAccuracyNotes: 'merge:/function/:address/evidence + /results',
  showInvestigate: 'merge:/investigate',
  showDataTables: 'merge:/explorer/data',
  showDataTable: 'merge:/explorer/data',
  showCandidates: 'merge:/investigate + /results',
  showCandidateWhy: 'merge:/finding/:id + /function/:address/evidence',
  showFunctionReport: 'merge:/function/:address/overview',
  showCallGraph: 'merge:/function/:address/calls',
  showValueFlow: 'merge:/function/:address/overview + code inspector',
  showAddressInfo: 'merge:global command + code inspector',
  showSettings: 'redirect:/settings',
  showHelp: 'redirect:/help',
  showWelcome: 'merge:/investigate onboarding',
  showLearn: 'redirect:/learn',
  showGlossary: 'merge:/learn',
  showTerm: 'merge:/learn',
  showSampleGuide: 'merge:/learn + /investigate onboarding',

  showTools: 'merge:/advanced + contextual actions',
  showDecompiler: 'merge:/function/:address/pseudocode',
  showCfg: 'merge:/function/:address/flow',
  showCallGraphPanel: 'merge:/function/:address/calls',
  showTypes: 'merge:/function/:address/overview',
  showStructRecover: 'merge:/explorer/data + /function/:address/overview',
  showStructs: 'merge:/explorer/data + /advanced',
  showCxxClasses: 'merge:/explorer/classes',
  showRename: 'merge:function context action',
  showComment: 'merge:function/code context action',
  showNotes: 'merge:/results + /advanced',
  showLinkage: 'merge:/explorer/external',
  showGlobals: 'merge:/explorer/data',
  showPatches: 'merge:/advanced + code context action',
  showPatchEditor: 'merge:code context action',
  showDebugger: 'merge:/function/:address/runtime',
  showScript: 'redirect:/advanced',
  showPlugins: 'redirect:/advanced',
  showIl2cpp: 'merge:/explorer/classes + /advanced',
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
