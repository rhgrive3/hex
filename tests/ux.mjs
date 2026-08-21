import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchRoute } from '../js/ui/router.js';
import { ROUTES, PRIMARY_NAV, LEGACY_MIGRATION, createActionRegistry } from '../js/ui/registry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const index = read('index.html');
const ui = read('js/ui.js');
const ux = read('js/ux.js');
const uxCss = read('css/ux.css');
const shell = read('css/shell.css');
const mobile = read('css/mobile.css');
const components = read('css/components.css');
const product = read('js/ui/product.js');
const registry = read('js/ui/registry.js');
let failures = 0;

function check(name, value) {
  const ok = !!value;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
}

check('compatibility CSS entrypoint remains loaded', index.includes('./css/ux.css'));
check('compatibility JS bootstrap remains loaded', index.includes('./js/ux.js'));
check('ux.js is a thin product bootstrap', ux.includes('installProductUI') && !ux.includes('MutationObserver'));
check('legacy hidden-button architecture is not recreated', !ux.includes('ux-source-action') && !ux.includes('ux-v2'));
check('legacy analysis actions are not delegated through DOM click', !/(btn-tools|btn-functions|btn-search|btn-jump|btn-strings|btn-sections|btn-struct)[\s\S]{0,160}\.click\(/.test(ux));
check('file picker activation is an explicit canonical action', ux.includes("actions.register('file.open'") && ux.includes("getElementById('file-input')?.click()"));
check('ux.css is only a canonical stylesheet entrypoint', uxCss.includes('./tokens.css') && uxCss.includes('./mobile.css') && !uxCss.includes('.ux-v2'));

check('modern copy path retained', ui.includes('navigator.clipboard.writeText'));
check('legacy Safari copy fallback retained', ui.includes("document.execCommand('copy')") && ui.includes("document.createElement('textarea')"));
check('outside menu handler cleanup retained', ui.includes("document.removeEventListener('pointerdown', outside, true)"));
check('context menu closes on scroll', ui.includes("document.addEventListener('scroll', move, true)"));
check('context menu scroll cleanup retained', ui.includes("document.removeEventListener('scroll', move, true)"));
check('legacy Sheet remains compatibility-only primitive', ui.includes('export class Sheet'));

check('primary navigation is task-centric and <= 5 items', PRIMARY_NAV.length === 4 && PRIMARY_NAV.map((x) => x.routeId).join(',') === 'investigate,code,explorer,results');
check('canonical routes have unique ids', new Set(ROUTES.map((x) => x.id)).size === ROUTES.length);
check('canonical route patterns are unique', new Set(ROUTES.map((x) => x.pattern)).size === ROUTES.length);
check('default investigate route resolves', matchRoute(ROUTES, '/investigate')?.route.id === 'investigate');
check('optional code address resolves without trailing slash', matchRoute(ROUTES, '/code')?.route.id === 'code');
check('code address deep link resolves', matchRoute(ROUTES, '/code/4294967296')?.params.address === '4294967296');
check('function tab deep link resolves', matchRoute(ROUTES, '/function/4096/pseudocode')?.params.tab === 'pseudocode');
check('explorer scope resolves', matchRoute(ROUTES, '/explorer/strings')?.params.scope === 'strings');
check('unknown path does not falsely resolve', matchRoute(ROUTES, '/does-not-exist') == null);

const actions = createActionRegistry();
let ran = false;
actions.register('test', () => { ran = true; });
actions.run('test');
check('action registry runs the canonical action', ran);
let duplicateRejected = false;
try { actions.register('test', () => {}); } catch { duplicateRejected = true; }
check('action registry rejects duplicate sources of truth', duplicateRejected);

check('legacy screens have migration dispositions', Object.keys(LEGACY_MIGRATION).length >= 20);
check('summary/report are merged into function workspace', LEGACY_MIGRATION.showFunctionSummary?.includes('/function/') && LEGACY_MIGRATION.showFunctionReport?.includes('/function/'));
check('decompiler and CFG are function workspace tabs', LEGACY_MIGRATION.showDecompiler?.includes('pseudocode') && LEGACY_MIGRATION.showCfg?.includes('flow'));
check('search and jump are not top-level duplicates', LEGACY_MIGRATION.showSearch?.startsWith('merge:') && LEGACY_MIGRATION.showJump?.startsWith('merge:'));

check('product UI owns browser-backed router', product.includes('new ProductRouter') && product.includes('router.start()'));
check('global search recognizes addresses and commands', product.includes('parseAddress(q)') && product.includes("router.navigate('/settings')"));
check('function workspace renders canonical tabs', product.includes('FUNCTION_TABS') && product.includes('renderFunctionWorkspace'));
check('Explorer uses windowed rendering', product.includes('new VirtualList'));
check('visualViewport keyboard bridge exists', product.includes('window.visualViewport') && product.includes('--ui-keyboard-inset'));
check('route views save state instead of DOM nodes', product.includes('getState:') && product.includes('restoreState:'));
check('evidence semantic state is separate from ranking', product.includes('functionEvidence?.(addr)') && product.includes('nameEvidence?.(addr)') && product.includes('provenanceStatus(nameEvidence)'));

check('canonical z-index layers are tokenized', ['--ui-z-sticky','--ui-z-inspector','--ui-z-backdrop','--ui-z-sheet','--ui-z-popover','--ui-z-dialog','--ui-z-toast'].every((token) => read('css/tokens.css').includes(token)));
check('new screens do not horizontally overflow body by design', shell.includes('min-width: 0') && read('css/base.css').includes('overflow-x: hidden'));
check('phone navigation is persistent', mobile.includes('.ui-bottom-nav { display: grid; }'));
check('landscape phone compresses navigation chrome', mobile.includes('(orientation: landscape)') && mobile.includes('max-height: 480px'));
check('safe-area variables are used for fixed mobile chrome', mobile.includes('var(--ui-safe-bottom)') && shell.includes('var(--ui-safe-right)'));
check('phone code hides bytes only in ASM mode', mobile.includes('.viewport.mode-asm .c-hex'));
check('decompiler supports local horizontal scrolling/wrap', components.includes('.ui-pseudocode') && components.includes('.ui-pseudocode.wrap'));
check('graphs include a text representation style', components.includes('.ui-graph-text'));
check('touch targets use the shared 44px token', components.includes('min-height: var(--ui-touch)'));
check('reduced motion is supported', read('css/base.css').includes('prefers-reduced-motion'));

if (failures) process.exit(1);
console.log('Product UI architecture regression checks passed');
