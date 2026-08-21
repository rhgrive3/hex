import { matchRoute, ProductRouter } from '../../js/ui/router.js';
import {
  ROUTES, PRIMARY_NAV, EXPLORER_SCOPES, FUNCTION_TABS, LEGACY_MIGRATION,
} from '../../js/ui/registry.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const expectedRoutes = new Set(['investigate','code','explorer','results','diff','function','finding','settings','help','learn','advanced']);
check('all canonical route ids are present', expectedRoutes.size === ROUTES.length && ROUTES.every((route) => expectedRoutes.has(route.id)));
check('each route has a screen kind', ROUTES.every((route) => route.kind === 'screen' || route.kind === 'workspace'));
check('each primary nav destination resolves', PRIMARY_NAV.every((item) => matchRoute(ROUTES, item.route)?.route.id === item.routeId));
check('no duplicate primary route id', new Set(PRIMARY_NAV.map((item) => item.routeId)).size === PRIMARY_NAV.length);
check('investigate is the first primary task', PRIMARY_NAV[0]?.routeId === 'investigate');
check('tools are not a primary task', !PRIMARY_NAV.some((item) => /tool|advanced/.test(item.routeId)));

for (const scope of EXPLORER_SCOPES) {
  const hit = matchRoute(ROUTES, '/explorer/' + scope.id);
  check(`explorer scope ${scope.id} resolves`, hit?.route.id === 'explorer' && hit.params.scope === scope.id);
}
for (const tab of FUNCTION_TABS) {
  const hit = matchRoute(ROUTES, '/function/4096/' + tab.id);
  check(`function tab ${tab.id} resolves`, hit?.route.id === 'function' && hit.params.address === '4096' && hit.params.tab === tab.id);
}

const legacyRequired = [
  'showFileInfo','showSections','showStructure','showFunctions','showFunctionSummary','showBlockDetail',
  'showFeatures','showStrings','showJump','showSearch','showXrefs','showDetail','showOverview','showAppMap',
  'showSubsystem','showClass','showField','showPinned','showAccuracyNotes','showInvestigate','showDataTables',
  'showDataTable','showCandidates','showCandidateWhy','showFunctionReport','showCallGraph','showValueFlow',
  'showAddressInfo','showSettings','showHelp','showWelcome','showLearn','showGlossary','showTerm','showSampleGuide',
  'showTools','showDecompiler','showCfg','showCallGraphPanel','showTypes','showStructRecover','showStructs',
  'showCxxClasses','showRename','showComment','showNotes','showLinkage','showGlobals','showPatches','showPatchEditor',
  'showDebugger','showScript','showPlugins','showIl2cpp',
];
check('audited legacy inventory contains 54 exported screens', legacyRequired.length === 54);
check('migration table contains exactly the audited 54 screens', Object.keys(LEGACY_MIGRATION).length === legacyRequired.length);
check('every audited legacy screen has a migration disposition', legacyRequired.every((name) => typeof LEGACY_MIGRATION[name] === 'string'));
check('migration table has no un-audited screen names', Object.keys(LEGACY_MIGRATION).every((name) => legacyRequired.includes(name)));
check('migration table has only explicit dispositions', Object.values(LEGACY_MIGRATION).every((value) => /^(merge|redirect|deprecated):/.test(value)));

/* A render failure must not manufacture a browser-history entry. Result sheets
   use navigate()'s boolean to decide whether they may close, so URL/history,
   router.current and the visible view must commit together. */
const previousWindow = globalThis.window;
const previousHistory = globalThis.history;
const pushes = [];
try {
  globalThis.window = {
    location: { href: 'https://hex.test/#/code', hash: '#/code' },
    addEventListener() {}, removeEventListener() {},
  };
  globalThis.history = {
    state: { hexUi: true, key: 1, depth: 0, viewState: null },
    pushState(state, _title, url) { pushes.push({ state, url }); this.state = state; },
    replaceState(state) { this.state = state; },
    back() {}, forward() {},
  };
  const current = matchRoute(ROUTES, '/code');
  const router = new ProductRouter(ROUTES, {
    defaultPath: '/code',
    onRoute(next) {
      if (next.route.id === 'function') throw new Error('synthetic-render-failure');
      return null;
    },
  });
  router.current = { ...current, fullPath: '/code', query: new URLSearchParams() };
  router.depth = 0;
  check('render failure returns false without committing history', router.navigate('/function/4096/pseudocode') === false && pushes.length === 0);
  check('render failure preserves route and back depth', router.current.fullPath === '/code' && router.depth === 0 && window.location.hash === '#/code');
} finally {
  if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
  if (previousHistory === undefined) delete globalThis.history; else globalThis.history = previousHistory;
}

if (failures) process.exit(1);
console.log('Canonical route manifest checks passed');