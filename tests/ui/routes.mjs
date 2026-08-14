import { matchRoute } from '../../js/ui/router.js';
import {
  ROUTES, PRIMARY_NAV, EXPLORER_SCOPES, FUNCTION_TABS, LEGACY_MIGRATION,
} from '../../js/ui/registry.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const expectedRoutes = new Set(['investigate','code','explorer','results','function','finding','settings','help','learn','advanced']);
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
  'showOverview','showInvestigate','showFeatures','showSearch','showJump','showFunctions','showStrings',
  'showSections','showStructure','showFunctionSummary','showFunctionReport','showDecompiler','showCfg',
  'showCallGraphPanel','showTypes','showDebugger','showAccuracyNotes','showFileInfo','showSettings','showHelp',
  'showLearn','showTools',
];
check('every tracked legacy screen has a migration disposition', legacyRequired.every((name) => typeof LEGACY_MIGRATION[name] === 'string'));
check('migration table has only explicit dispositions', Object.values(LEGACY_MIGRATION).every((value) => /^(merge|redirect|deprecated):/.test(value)));

if (failures) process.exit(1);
console.log('Canonical route manifest checks passed');
