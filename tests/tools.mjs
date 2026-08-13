/*
 * 解析ツール（tools.js）を、実際にブラウザで押して確かめる。
 *
 * 擬似コードも、図も、デバッガも、Node の足場では「動いたつもり」になれてしまう。
 * ここは Playwright で本当にボタンを押し、出てきた文字を読んで判定する。
 *
 * 使い方:
 *   node tests/tools.mjs                    # tests/battlecats で通す
 *   node tests/tools.mjs path/to/binary
 *   KEEP=1 node tests/tools.mjs             # 画面の写しを残す
 *
 * Playwright が無ければ、測らずに「測っていない」と言って終わる。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BINARY = path.resolve(ROOT, process.argv[2] || 'tests/battlecats');
const SHOTS = process.env.KEEP ? path.join(HERE, '.shots') : null;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm',
};

async function loadPlaywright() {
  const unwrap = (m) => (m && m.chromium ? m : (m && m.default && m.default.chromium ? m.default : null));
  try {
    const got = unwrap(await import('playwright'));
    if (got) return got;
  } catch { /* 次を試す */ }
  const home = process.env.HOME || '';
  const cache = path.join(home, '.npm', '_npx');
  if (!fs.existsSync(cache)) return null;
  for (const d of fs.readdirSync(cache)) {
    const p = path.join(cache, d, 'node_modules', 'playwright', 'index.js');
    if (!fs.existsSync(p)) continue;
    try {
      const got = unwrap(await import(pathToFileURL(p).href));
      if (got) return got;
    } catch { /* 次 */ }
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

const sheetOf = (page) => page.locator('#overlays .sheet').last();

/**
 * 開いているものを全部閉じる。
 * シートだけでなく、メニューやダイアログの「覆い」も残らないようにする
 * （覆いが 1 枚でも残ると、次にツールバーを押せない）。
 */
async function closeSheets(page) {
  for (let i = 0; i < 10; i++) {
    // トーストは自分で消えるので、数に入れない（数えると Escape を無駄打ちする）
    if (!(await page.locator('#overlays .backdrop, #overlays .sheet').count())) return;
    if (await page.locator('#overlays .sheet').count()) {
      const done = sheetOf(page).locator('.sheet-head button').last();
      if (await done.count()) { await done.click({ force: true }); await page.waitForTimeout(250); continue; }
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    const back = page.locator('#overlays .backdrop').last();
    if (await back.count()) await back.click({ force: true });
    await page.waitForTimeout(200);
  }
}

/** 検索が終わる（進み具合の表示が止まる）まで待つ。 */
async function waitForSearch(page, max = 90000) {
  const until = Date.now() + max;
  while (Date.now() < until) {
    const text = await sheetOf(page).innerText().catch(() => '');
    if (/件見つかりました|見つかりませんでした|止めました|打ち切り/.test(text)) return text;
    await page.waitForTimeout(1000);
  }
  return await sheetOf(page).innerText().catch(() => '');
}

/** ツールバーの「解析ツール」から、名前で 1 つ開く。 */
async function openTool(page, label) {
  await closeSheets(page);
  await page.click('#btn-tools');
  await page.waitForTimeout(400);
  const row = page.locator('#overlays .sheet li', { hasText: label }).first();
  if (!(await row.count())) return false;
  await row.click();
  await page.waitForTimeout(900);
  return true;
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail.slice(0, 120) : ''}`);
};

async function main() {
  const pw = await loadPlaywright();
  if (!pw) {
    console.log('Playwright がありません。画面での確かめは省きます。');
    console.log('  入れるなら: npx playwright install chromium');
    return 0;
  }
  if (!fs.existsSync(BINARY)) {
    console.error('バイナリがありません: ' + BINARY);
    return 1;
  }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1024, height: 1366 }, locale: 'ja-JP' });

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    for (let i = 0; i < 8; i++) {
      const b = page.locator('#overlays button')
        .filter({ hasText: /^(次へ|閉じる|はじめる|完了)$/ }).last();
      if (!(await b.count())) break;
      await b.click();
      await page.waitForTimeout(300);
    }

    console.log(`\n${path.basename(BINARY)} を開く…`);
    await page.setInputFiles('#file-input', BINARY);
    await page.waitForTimeout(4000);
    await closeSheets(page);

    /* 関数を 1 つ選んでおく（ツールは「いま見ている関数」に効く） */
    await page.click('#btn-functions');
    await page.waitForTimeout(2500);
    const fnRow = page.locator('#overlays .sheet li.tappable').first();
    const haveFn = await fnRow.count();
    if (haveFn) { await fnRow.click(); await page.waitForTimeout(1500); }
    await closeSheets(page);
    check('関数を 1 つ開ける', !!haveFn);

    /* ── 擬似コード ── */
    console.log('\n擬似コード');
    let ok = await openTool(page, '擬似コード');
    let text = ok ? await sheetOf(page).innerText() : '';
    check('擬似コードの画面が開く', ok);
    check('C 風の行が出ている', /[;{}]/.test(text) && /\w+\s*=/.test(text),
      (text.match(/^\s*\S.*=.*;$/m) || [''])[0].trim());
    check('関数の見出し（型つき）が出ている', /\w+\s+\w+\(/.test(text),
      (text.match(/^\w[\w *]*\s+\w+\(.*\)$/m) || [''])[0]);
    check('「訳であって元のソースではない」と断っている', /元のソースコードではありません/.test(text));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'decompile.png') });

    /* アセンブリの併記に切り替えられる */
    const asmChip = page.locator('#overlays .sheet button', { hasText: 'アセンブリも表示' }).first();
    if (await asmChip.count()) {
      await asmChip.click();
      await page.waitForTimeout(400);
      const withAsm = await sheetOf(page).innerText();
      check('アセンブリを併記できる', /;\s*(ldr|str|mov|add|sub|bl|ret|stp|ldp|b)\b/.test(withAsm));
    } else check('アセンブリを併記できる', false, 'ボタンが無い');

    /* ── 制御フロー図 ── */
    console.log('\n制御フロー図');
    ok = await openTool(page, '制御フロー図');
    const boxes = await page.locator('#overlays .sheet svg.graph .g-box').count();
    check('CFG が図として描かれる', ok && boxes > 0, boxes + ' 個の箱');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'cfg.png') });

    /* ── 呼び出し図 ── */
    console.log('\n呼び出し図');
    ok = await openTool(page, '呼び出し図');
    await page.waitForTimeout(2000);
    const callBoxes = await page.locator('#overlays .sheet svg.graph .g-box').count();
    check('呼び出し図が描かれる', ok && callBoxes > 0, callBoxes + ' 個の箱');

    /* ── 型 ── */
    console.log('\n引数と戻り値');
    ok = await openTool(page, '引数・戻り値・変数の型');
    text = ok ? await sheetOf(page).innerText() : '';
    check('引数・戻り値の推定が出る', ok && /(引数|戻り値)/.test(text));
    check('確からしさを星で見せる', /★/.test(text));

    /* ── デバッガ ── */
    console.log('\n実行してみる');
    ok = await openTool(page, '実行してみる');
    text = ok ? await sheetOf(page).innerText() : '';
    check('デバッガの画面が開く', ok && /レジスタ/.test(text));
    const runBtn = page.locator('#overlays .sheet button', { hasText: '最後まで走らせる' }).first();
    if (await runBtn.count()) {
      await runBtn.click();
      await page.waitForTimeout(3000);
      const after = await sheetOf(page).innerText();
      check('実際に命令が動く', /合計 \d+ 命令|命令ぶん進んだ|実行おわり|命令まで進みました|ブレークポイント/.test(after),
        (after.match(/合計 \d+ 命令[^\n]*/) || [''])[0]);
      check('レジスタの値が 16 進で出る', /0x[0-9A-F]{16}/.test(after));
    } else check('実際に命令が動く', false, 'ボタンが無い');
    const bpInput = sheetOf(page).locator('input[placeholder*="止めたい"]').first();
    if (await bpInput.count()) {
      await bpInput.fill('0x100004010');
      await sheetOf(page).locator('button', { hasText: '置く' }).first().click();
      await page.waitForTimeout(400);
      text = await sheetOf(page).innerText();
      check('ブレークポイントを置ける', /0x0*100004010/.test(text),
        (text.match(/0x[0-9A-F]*100004010/) || [''])[0]);
    } else check('ブレークポイントを置ける', false, '入力欄が無い');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'debugger.png') });

    /* ── 外とのつながり ── */
    console.log('\n外とのつながり');
    ok = await openTool(page, '外とのつながり');
    await page.waitForTimeout(1500);
    text = ok ? await sheetOf(page).innerText() : '';
    check('借りている関数が並ぶ', ok && /借りている関数 \d+ 個/.test(text),
      (text.match(/借りている関数 \d+ 個/) || [''])[0]);
    const dylibTab = page.locator('#overlays .sheet button', { hasText: 'ライブラリ' }).first();
    if (await dylibTab.count()) {
      await dylibTab.click();
      await page.waitForTimeout(500);
      const libs = await sheetOf(page).innerText();
      check('読み込むライブラリの一覧が出る', /dylib|framework/i.test(libs));
    }

    /* ── グローバル変数 ── */
    console.log('\nグローバル変数');
    ok = await openTool(page, 'グローバル変数');
    await page.waitForTimeout(2500);
    text = ok ? await sheetOf(page).innerText() : '';
    check('グローバル変数が並ぶ', ok && /か所から参照/.test(text),
      (text.match(/\d+ か所から参照/) || [''])[0]);

    /* ── スクリプト ── */
    console.log('\nスクリプト');
    ok = await openTool(page, 'スクリプト');
    const runScript = page.locator('#overlays .sheet button', { hasText: '実行' }).first();
    if (ok && await runScript.count()) {
      await runScript.click();
      await page.waitForTimeout(3000);
      text = await sheetOf(page).innerText();
      check('スクリプトが動いて結果が出る', /— おわり —/.test(text) && !/⚠/.test(text),
        (text.match(/0x[0-9A-F]+[^\n]*/) || [''])[0]);
    } else check('スクリプトが動いて結果が出る', false, '開けない');

    /* ── 名前を付ける ── */
    console.log('\n名前を付ける');
    ok = await openTool(page, '名前を付ける');
    const nameInput = sheetOf(page).locator('input').first();
    if (ok && await nameInput.count()) {
      await nameInput.fill('テスト用の名前');
      await sheetOf(page).locator('button', { hasText: '決定' }).first().click();
      await page.waitForTimeout(800);
      await closeSheets(page);
      await page.click('#btn-tools');
      await page.waitForTimeout(500);
      const hub = await sheetOf(page).innerText();
      check('付けた名前がすぐ反映される', /テスト用の名前/.test(hub),
        (hub.match(/テスト用の名前/) || [''])[0]);
    } else check('付けた名前がすぐ反映される', false, '開けない');

    /* ── 数値の検索 ── */
    console.log('\n数値で探す');
    await closeSheets(page);
    await page.click('#btn-search');
    await page.waitForTimeout(500);
    const numChip = page.locator('#overlays .sheet button', { hasText: '数値' }).first();
    if (await numChip.count()) {
      await numChip.click();
      await sheetOf(page).locator('input').first().fill('100');
      await sheetOf(page).locator('button', { hasText: '検索' }).first().click();
      text = await waitForSearch(page);
      check('数値をそのまま入れて探せる', /件見つかりました|見つかりませんでした/.test(text),
        (text.match(/[^\n]*件[^\n]*/) || [text.replace(/\n/g, ' ').slice(0, 160)])[0]);
    } else check('数値をそのまま入れて探せる', false, 'チップが無い');

    /* ── パッチ ── */
    console.log('\nパッチ');
    ok = await openTool(page, 'パッチ');
    text = ok ? await sheetOf(page).innerText() : '';
    check('パッチの画面が開く', ok && /書き換え/.test(text));
    check('署名のことわりを出している', /署名/.test(text));

    await closeSheets(page);
    check('コンソールにエラーが出ない', errors.length === 0, errors.slice(0, 2).join(' / '));
  } finally {
    await browser.close();
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => {
  console.error(err);
  process.exit(1);
});
