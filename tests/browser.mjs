/*
 * 画面での確かめ（Playwright）。
 *
 * tests/accuracy.mjs は「取り出した事実が正しいか」を測る。
 * ここで測るのは、その先の **初めて開いた人が実際に見るもの**。
 *
 *   HP・体力 を押す → 何が出るか
 *
 * この 1 手で答えが決まらないなら、中の精度が何 % でもこのツールは使えない。
 * 実際、命令の精度が 19 機能すべて 90% 超えの状態で、HP を押すと
 * IronSource の死活監視（ISNHealthCheckConfig）が 72 個並んでいた。
 * Node の足場ではここが見えない。だからブラウザで押す。
 *
 * 使い方:
 *   node tests/browser.mjs                    # tests/battlecats で通す
 *   node tests/browser.mjs path/to/binary
 *   KEEP=1 node tests/browser.mjs             # 画面の写しを残す
 *
 * Playwright が入っていなければ、測らずに「測っていない」と言って終わる
 * （このリポジトリは node_modules を持たない静的サイトなので、必須にはしない）。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { vendorInText } from '../js/vendors.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BINARY_ARG = process.argv[2] || null;
const BINARY = BINARY_ARG ? path.resolve(ROOT, BINARY_ARG) : path.join(HERE, '.real-fixtures', 'battlecats');
const SHOTS = process.env.KEEP ? path.join(HERE, '.shots') : null;

/* ゲームの数値を探しているのに、組み込んだ SDK が首位に来てはいけない目的。 */
const GOALS = [
  { chip: 'HP・体力', id: 'hp' },
  { chip: '攻撃力', id: 'attack' },
  { chip: 'ダメージ計算', id: 'damage', confirms: true },
  { chip: '所持金・コイン', id: 'money' },
  { chip: 'アイテム・所持品', id: 'item' },
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm',
};

async function loadPlaywright() {
  const unwrap = (m) => (m && m.chromium ? m : (m && m.default && m.default.chromium ? m.default : null));
  try {
    const got = unwrap(await import('playwright'));
    if (got) return got;
  } catch { }
  const home = process.env.HOME || '';
  const cache = path.join(home, '.npm', '_npx');
  if (!fs.existsSync(cache)) return null;
  for (const d of fs.readdirSync(cache)) {
    const p = path.join(cache, d, 'node_modules', 'playwright', 'index.js');
    if (!fs.existsSync(p)) continue;
    try {
      const got = unwrap(await import(pathToFileURL(p).href));
      if (got) return got;
    } catch { }
  }
  return null;
}

function serve() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

const sheetOf = (page) => page.locator('#overlays .sheet:not(.parked)').last();

/** 開いているシートを、製品と同じ「背景タップ」契約で閉じる。 */
async function closeSheets(page) {
  for (let i = 0; i < 6; i++) {
    const activeSheet = page.locator('#overlays .sheet:not(.parked)');
    if (!(await activeSheet.count())) return;
    const backdrop = page.locator('#overlays .backdrop:not(.parked)').last();
    if (!(await backdrop.count())) throw new Error('active sheet has no active backdrop');
    await backdrop.click({ position: { x: 4, y: 4 } });
    await activeSheet.last().waitFor({ state: 'detached', timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(50);
  }
  if (await page.locator('#overlays .sheet:not(.parked)').count()) {
    throw new Error('active sheet did not close after repeated backdrop taps');
  }
}

async function settle(page, { step = 1000, need = 3, max = 180000 } = {}) {
  const until = Date.now() + max;
  let last = null, same = 0;
  while (Date.now() < until) {
    await page.waitForTimeout(step);
    if (await page.locator('#overlays .sheet .progress').count()) { same = 0; continue; }
    const now = await sheetOf(page).innerText().catch(() => '');
    if (now === last) { if (++same >= need) return true; } else same = 0;
    last = now;
  }
  return false;
}

function readCandidates(page) {
  return page.evaluate(() => [...document.querySelectorAll('#overlays .sheet .cand')]
    .map((row) => ({
      text: row.textContent.replace(/\n+/g, ' ').trim(),
      score: Number((row.querySelector('.cand-score')?.textContent || '').replace('%', '')) || 0,
    })));
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

async function main() {
  if (!fs.existsSync(BINARY)) {
    if (!BINARY_ARG) {
      console.log('検証済み実バイナリがないため、BattleCats の heavyweight browser regression を省きます。');
      console.log('  実行するなら: npm run fixtures:large');
      return 0;
    }
    console.error('バイナリがありません: ' + BINARY);
    return 1;
  }
  if (fs.statSync(BINARY).size < 256 && fs.readFileSync(BINARY, 'utf8').startsWith('HEX_LARGE_FIXTURE_PLACEHOLDER')) {
    console.error('互換ポインタは実行ファイルではありません: ' + BINARY);
    console.error('  検証済み実fixtureを取得するなら: npm run fixtures:large');
    return 1;
  }
  const pw = await loadPlaywright();
  if (!pw) {
    const msg = 'Playwright がありません。画面での確かめは省きます。';
    if (process.env.CI) {
      console.error(msg + ' CIではブラウザテストを必須にします。');
      console.error('  入れるなら: npm install -D playwright && npx playwright install chromium');
      return 1;
    }
    console.log(msg);
    console.log('  入れるなら: npm install -D playwright && npx playwright install chromium');
    return 0;
  }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1024, height: 1366 }, locale: 'ja-JP' });

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: 'networkidle' });

    for (let i = 0; i < 8; i++) {
      const b = page.locator('#overlays button')
        .filter({ hasText: /^(次へ|閉じる|はじめる|完了)$/ }).last();
      if (!(await b.count())) break;
      await b.click();
      await page.waitForTimeout(400);
    }
    check('案内を閉じたら、画面が使える状態になる',
      !(await page.locator('#overlays .sheet').count()));

    const copiedByFallback = await page.evaluate(async () => {
      const originalExec = document.execCommand;
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
      document.execCommand = (command) => command === 'copy';
      try {
        const { copyText } = await import('../js/ui.js');
        return await copyText('Safari fallback', 'test');
      } finally {
        delete navigator.clipboard;
        document.execCommand = originalExec;
      }
    });
    check('Clipboard APIなしでもコピーできる', copiedByFallback);

    await page.evaluate(async () => {
      const { menu } = await import('../js/ui.js');
      menu([{ label: 'test', action() {} }], 40, 40);
    });
    await page.mouse.click(500, 500);
    check('コンテキストメニューは外側タップで閉じる', !(await page.locator('#overlays .menu').count()));

    await page.evaluate(async () => {
      const { Sheet } = await import('../js/ui.js');
      const first = new Sheet('履歴A');
      first.close();
      new Sheet('履歴B');
    });
    await sheetOf(page).locator('.sheet-nav-btn.back').click();
    check('シートの戻るで前の画面へ戻る', (await sheetOf(page).locator('.sheet-title').innerText()) === '履歴A');
    await sheetOf(page).locator('.sheet-nav-btn.forward').click();
    check('シートの進むで次の画面へ進む', (await sheetOf(page).locator('.sheet-title').innerText()) === '履歴B');
    await closeSheets(page);
    await page.evaluate(async () => {
      const { Sheet } = await import('../js/ui.js');
      new Sheet('背景タップ');
    });
    await page.locator('#overlays .backdrop:not(.parked)').click({ position: { x: 4, y: 4 } });
    await page.waitForTimeout(50);
    check('シートは背景タップで閉じる', !(await page.locator('#overlays .sheet').count()));

    console.log(`\n${path.basename(BINARY)} を開く…`);
    await page.setInputFiles('#file-input', BINARY);
    const done = await settle(page);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    check('開いただけで自動解析が終わる', done, secs + ' 秒');
    check('開いた直後はコードが主役（シートが勝手に出ない）',
      !(await page.locator('#overlays .sheet').count()) && (await page.locator('#rows .row').count()) > 0);
    check('AI はいつでも呼べる場所にいる', await page.locator('#ai-launcher').count() === 1);
    await page.evaluate(() => window.__app.openOverview());
    await page.waitForTimeout(400);
    check('概要を開けば目的から始まる', await sheetOf(page).getByText('何を知りたいですか？', { exact: true }).count());
    check('専門家向けツールは最初は閉じている',
      await sheetOf(page).locator('details.expert-entry:not([open])').count());
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'auto.png') });

    const auto = await sheetOf(page).innerText();
    if (SHOTS) fs.writeFileSync(path.join(SHOTS, 'auto.txt'), auto);
    const badHex = auto.match(/0x-[0-9a-f]+/i);
    check('負のずらし幅を `x29 - 0x60` と書く', !badHex, badHex ? badHex[0] : '');

    const raw = auto.match(/[❓🔧📺🧑⚔️🎒🗺️🎰💳🔑💬🏆🌐💾🚨📱🔊🎓⚠️⚙️]\s*[a-z][a-z0-9_]*\n/gi);
    check('部品の名前に、中の分類名を出さない', !raw,
      raw ? raw.map((s) => s.trim()).join(', ') : '');

    for (const goal of GOALS) {
      console.log(`\n「${goal.chip}」を押す`);
      await closeSheets(page);
      await page.click('#btn-investigate');
      await page.waitForTimeout(600);
      const chip = page.locator('[data-screen="investigate"] button', { hasText: goal.chip.trim() }).first();
      if (!(await chip.count())) { check(`${goal.id}: 目的が選べる`, false, 'チップが無い'); continue; }
      await chip.click();
      await settle(page, { max: 180000 });
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'goal-' + goal.id + '.png') });

      const sheet = sheetOf(page);
      const text = await sheet.innerText();
      if (SHOTS) fs.writeFileSync(path.join(SHOTS, 'goal-' + goal.id + '.txt'), text);
      const named = await sheet.locator('.pinned-name').count();
      const name = named ? (await sheet.locator('.pinned-name').first().innerText()).trim() : '';
      const verdictEl = sheet.locator('.verdict-word').first();
      const verdict = (await verdictEl.count())
        ? (await verdictEl.innerText()).trim()
        : (text.split('\n')[2] || '').trim();
      const conf = (/確からしさ\s*(非常に高い|高い|中程度|低い|非常に低い)/.exec(text) || [])[1] || '';
      check(`${goal.id}: 答えが出たときは結論を候補一覧より先に置く`,
        !named || !text.includes('ほかの候補を見る') || text.indexOf(name) < text.indexOf('ほかの候補を見る'));
      check(`${goal.id}: 専門情報は詳しく見るまで閉じている`,
        await sheet.locator('details:not([open])').count());

      if (named) {
        await page.waitForTimeout(1200);
        const rail = await sheet.locator('.flow-rail .flow-node').count();
        const honest = await sheet
          .locator('.flow-host .beginner-empty, .flow-host .flow-note, .flow-view').count();
        const stuck = await sheet.locator('.flow-pending').count();
        check(`${goal.id}: 数の流れが出るか、出せない理由が出る`, !stuck && (rail > 0 || honest > 0),
          stuck ? '読み込みのまま止まっている' : (rail ? rail + ' 段' : '正直な空表示'));
      }

      if (goal.id === 'damage') {
        const openRoutine = sheet.getByRole('button', { name: /処理を見る|書き換えている場所を開く/ }).first();
        if (await openRoutine.count()) {
          await openRoutine.click();
          await settle(page);
          const reportTitle = await sheetOf(page).locator('.sheet-title').innerText();
          check('答えから処理を開ける', /この関数について/.test(reportTitle));
          await sheetOf(page).locator('.sheet-nav-btn.back').click();
          check('処理から答えへ戻れる', await sheetOf(page).locator('.pinned-name').count());
        }
      }

      const bogus = named > 0 && (/見つかりませんでした/.test(text) || !conf);
      check(`${goal.id}: 見合う根拠のない名前を、答えとして出さない`, !bogus,
        bogus ? `${verdict} なのに「${name}」の確信度表示がない`
          : (named ? `${verdict}（${name} / ${conf}）` : `${verdict}（名前は出していない）`));

      if (goal.confirms) {
        check(`${goal.id}: 根拠がそろっていれば、確定と言い切る`,
          /確定/.test(verdict), verdict + (named ? `（${name} / ${conf}）` : ''));
      }

      const cands = await readCandidates(page);
      const top = cands.slice(0, 5);
      const sdk = top.map((c) => ({ c, v: vendorInText(c.text) })).filter((x) => x.v);
      check(`${goal.id}: 上位 5 件に、組み込んだ SDK を混ぜない`,
        sdk.length === 0,
        sdk.length ? sdk.map((x) => x.v.vendor).join(', ')
          : (top[0] ? '首位 ' + top[0].text.slice(0, 48) : '候補なし'));

      const CONCRETE = /減らす|増やす|入れる|読み出す|組み立てる|渡すだけ|詰めていく|埋め込まれている|比べて分かれる/;
      const said = top.filter((c) => CONCRETE.test(c.text));
      check(`${goal.id}: 候補が「何をしている処理か」まで言えている`,
        top.length ? said.length >= Math.ceil(top.length / 2) : true,
        said.length + '/' + top.length +
          (top[0] ? '  ·  首位: ' + top[0].text.slice(0, 56) : ''));
    }

    check('コンソールにエラーが出ない', errors.length === 0, errors.slice(0, 3).join(' / '));

    const en = await browser.newPage({ viewport: { width: 1024, height: 900 }, locale: 'en-US' });
    await en.goto(url, { waitUntil: 'domcontentloaded' });
    await en.waitForTimeout(1200);
    const bar = await en.locator('.toolbar').innerText();
    const ja = bar.match(/[ぁ-んァ-ヶ一-龥]+/g);
    check('英語の端末で、ツールバーに日本語が残らない', !ja, ja ? ja.join(' ') : bar.replace(/\n/g, ' '));
    await en.close();

    for (const viewport of [{ width: 390, height: 844 }, { width: 820, height: 1180 }]) {
      const responsive = await browser.newPage({ viewport, locale: 'ja-JP' });
      await responsive.goto(url, { waitUntil: 'domcontentloaded' });
      await responsive.waitForTimeout(800);
      const open = responsive.locator('#btn-open-2');
      const box = await open.boundingBox();
      check(`${viewport.width < 500 ? 'mobile' : 'tablet'} viewportでファイルを開くボタンが画面内にある`,
        !!box && box.x >= 0 && box.x + box.width <= viewport.width && box.height >= 44);
      await responsive.close();
    }
  } finally {
    await browser.close();
    server.close();
  }

  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
  if (SHOTS) console.log('画面の写し: ' + SHOTS);
  return bad.length ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => {
  console.error(err);
  process.exit(1);
});
