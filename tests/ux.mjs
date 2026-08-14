import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NavigationHistory } from '../js/navigation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const index = read('index.html');
const ui = read('js/ui.js');
const ux = read('js/ux.js');
const css = read('css/ux.css');
const panels = read('js/panels.js');
const app = read('js/app.js');
let failures = 0;

function check(name, value) {
  const ok = !!value;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
}

check('UX CSS loaded', index.includes('./css/ux.css'));
check('UX module loaded', index.includes('./js/ux.js'));
check('outside menu pointer handler', ui.includes("document.addEventListener('pointerdown', outside, true)"));
check('outside menu handler cleanup', ui.includes("document.removeEventListener('pointerdown', outside, true)"));
check('modern copy path retained', ui.includes('navigator.clipboard.writeText'));
check('legacy copy restores selection', ui.includes('selection.removeAllRanges()'));
check('legacy copy remains an editable Safari fallback', ui.includes("document.createElement('textarea')") && ui.includes("document.execCommand('copy')"));
check('context menu closes when scrolling begins', ui.includes("document.addEventListener('scroll', move, true)"));
check('context menu scroll handler is removed', ui.includes("document.removeEventListener('scroll', move, true)"));
check('sheet exposes back and forward', ui.includes('goForward()') && ui.includes('sheet-nav-btn forward'));
check('sheet breadcrumb exists', ui.includes("el('nav', 'sheet-trail')"));
check('sheet focus is trapped', ui.includes('trapFocus(e)'));
check('parked sheets cannot keep receiving input', ui.includes("this.root.setAttribute('inert', '')") && ui.includes("this.root.removeAttribute('inert')"));
check('touch rows support keyboard activation', ui.includes("li.setAttribute('role', 'button')") && ui.includes("e.key !== 'Enter'"));
check('goal route remains primary', ux.includes("investigate.classList.add('ux-primary')"));
check('find hub exists', ux.includes("'btn-find-hub'"));
check('analysis hub exists', ux.includes("'btn-analyze-hub'"));
check('old actions remain delegated', ['btn-search','btn-functions','btn-strings','btn-jump','btn-tools','btn-sections','btn-struct','btn-select'].every((id) => ux.includes(`$('${id}')`)));
check('duplicate actions hidden by class', ux.includes('ux-source-action') && css.includes('.ux-source-action'));
check('menu viewport bounded', css.includes('max-height: min(72dvh'));

check('no-file state follows empty visibility', ux.includes("app.classList.toggle('empty-state', !empty.hidden)"));
check('no-file chrome is removed', ['.toolbar', '.addrbar', '.colhead', '.statusbar'].every((part) => css.includes(`.app.empty-state ${part}`)));
check('no-file page scrolls on Safari', css.includes('overflow-y: auto') && css.includes('-webkit-overflow-scrolling: touch'));
check('real file picker is first action', ux.includes('actions.insertBefore(open, actions.firstElementChild)'));
check('file picker is primary action', ux.includes("open.classList.add('btn-primary')"));
check('sample is secondary action', ux.includes("sample.classList.add('btn-secondary')"));
check('landing headline is plain', ux.includes('解析するファイルを開く'));
check('decorative landing modules hidden', ['.empty-context', '.empty-rail', '.relation-lens', '.empty-kicker'].every((part) => css.includes(`.app.empty-state ${part}`)));
check('post-open screen starts from a purpose', panels.includes('何を知りたいですか？') && panels.includes('purpose-hero'));
check('expert tools are progressively disclosed', panels.includes("pick('専門家向けツール'") && panels.includes("expert.classList.add('expert-entry')"));
check('answer puts plain summary before technical detail', panels.indexOf("pick('何をしている？'") < panels.indexOf("pick('専門家向け詳細'"));
check('answer has an evidence-first section', panels.includes("pick('なぜ分かる？'"));
check('value flow uses existing analysis results', panels.includes('findValueUpdates(model)') && panels.includes('valueFlowView(update)'));
check('value flow has an honest empty state', panels.includes('この関数では値の流れを十分に復元できませんでした'));
check('viewer history controls are wired', app.includes('this.navigation.back()') && app.includes('this.navigation.forward()'));
check('mobile touch targets remain practical', css.includes('.sheet button, .sheet [role="button"]') && css.includes('min-height: 44px'));

const visited = [];
let state = null;
const history = new NavigationHistory({
  onNavigate: (entry) => visited.push(entry.label),
  onChange: (next) => { state = next; },
});
history.reset({ key: 'a', label: 'A' });
history.visit({ key: 'b', label: 'B' });
check('navigation history can go back', history.back() && visited.at(-1) === 'A' && state.canForward);
check('navigation history can go forward', history.forward() && visited.at(-1) === 'B' && state.canBack);

if (failures) process.exit(1);
console.log('UX regression checks passed');
