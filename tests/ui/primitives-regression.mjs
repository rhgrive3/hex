import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  const file = path.resolve(root, '.' + pathname);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/plain; charset=utf-8');
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/js/ui/primitives.js`);
  await page.setContent('<div id="host"></div>');
  await page.evaluate(async (port) => {
    const { tabs, VirtualList, h } = await import(`http://127.0.0.1:${port}/js/ui/primitives.js`);
    const host = document.querySelector('#host');
    window.__changes = [];
    const tablist = tabs([
      { id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' },
    ], 'a', (id) => window.__changes.push(id));
    tablist.id = 'tabs'; host.append(tablist);

    const list = new VirtualList({
      items: Array.from({ length: 30 }, (_, i) => ({ id: i, label: `item-${i}` })),
      rowHeight: 44, overscan: 0,
      renderRow: (item) => { const button = h('button', 'row-button', item.label); button.type = 'button'; return button; },
    });
    list.root.id = 'virtual'; list.root.style.height = '120px'; list.root.style.overflow = 'auto';
    host.append(list.root); list.render(true); window.__list = list;
  }, port);

  const first = page.locator('#tabs [role=tab]').first();
  await first.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'B');
  assert.equal(await page.locator('#tabs [role=tab][aria-selected=true]').textContent(), 'B');
  assert.deepEqual(await page.evaluate(() => window.__changes), ['b']);
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'C');
  await page.keyboard.press('Home');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'A');

  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#virtual .ui-virtual-row')];
    rows.find((row) => row.dataset.virtualIndex === '2').querySelector('button').focus();
    const list = window.__list;
    list.root.scrollTop = 44;
    list.render();
  });
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'item-2');
  assert.equal(await page.evaluate(() => document.activeElement?.closest('.ui-virtual-row')?.dataset.virtualIndex), '2');

  console.log('ui primitives regression: ok');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
