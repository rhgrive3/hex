import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const index = read('index.html');
const ui = read('js/ui.js');
const ux = read('js/ux.js');
const css = read('css/ux.css');
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

if (failures) process.exit(1);
console.log('UX regression checks passed');
