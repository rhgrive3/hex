/*
 * From a result to another view of the same routine.
 *
 * The complaint this covers: an automatic analysis names a function, and the
 * only way to read it as pseudo-C or as a diagram was to go back to the
 * function index and search for the address you had just been shown. Every
 * result surface must offer those views itself, with buttons that say what
 * they open, and with body text that is not flush against the sheet edge.
 */
import { openApp, reporter, run, closeSheets } from '../ai-ui-support.mjs';

await run(async ({ browser }) => {
  const { check, state } = reporter();
  const { context, page, errors } = await openApp(browser, { width: 1024, height: 1366, sample: true });

  const address = await page.evaluate(() => {
    const app = window.__app;
    const region = app.codeRegion();
    const list = app.symbols?.functionList?.(region, 4) || [];
    return list.length ? list[0].addr.toString() : null;
  });
  check('the sample provides a function to report on', !!address, String(address));
  if (!address) { await context.close(); return state.failures + 1; }
  const viewerLifecycle = await page.evaluate(() => ({
    chunkArrived: typeof window.__app.viewer.chunkArrived,
    dispose: typeof window.__app.viewer.dispose,
  }));
  check('viewer lifecycle hooks survive pointer-wiring changes',
    viewerLifecycle.chunkArrived === 'function' && viewerLifecycle.dispose === 'function',
    JSON.stringify(viewerLifecycle));

  /* ── the function report ─────────────────────────────────── */
  await page.evaluate(async (addr) => {
    const { showFunctionReport } = await import('/js/panels.js');
    showFunctionReport(window.__app, BigInt(addr));
  }, address);
  await page.waitForSelector('#overlays .sheet .next-views .action-btn', { timeout: 20000 });

  const bar = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('#overlays .sheet .next-views .action-btn')];
    return buttons.map((node) => ({
      label: node.querySelector('.action-label')?.textContent || '',
      hint: node.querySelector('.action-hint')?.textContent || '',
      height: Math.round(node.getBoundingClientRect().height),
      disabled: node.disabled,
    }));
  });
  check('a result offers pseudo-C and the flow diagram without leaving for the index',
    bar.some((b) => /疑似C/.test(b.label)) && bar.some((b) => /図/.test(b.label)), JSON.stringify(bar.map((b) => b.label)));
  check('every view button says what it opens', bar.length >= 3 && bar.every((b) => b.hint.length > 0), JSON.stringify(bar.map((b) => b.hint)));
  check('view buttons are comfortable tap targets', bar.every((b) => b.height >= 44), JSON.stringify(bar.map((b) => b.height)));
  check('the report does not offer a button back to the report', !bar.some((b) => /関数の概要/.test(b.label)), JSON.stringify(bar.map((b) => b.label)));

  const sections = await page.evaluate(() => document.querySelectorAll('#overlays .sheet .sec-title, #overlays .sheet .blk-title, #overlays .sheet .fn-name').length);
  check('the result is broken into named sections rather than one block of text', sections >= 3, String(sections));

  /* ── the wiring itself ───────────────────────────────────── */
  const routeBeforePseudo = await page.evaluate(() => location.hash);
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('#overlays .sheet .next-views .action-btn')]
      .find((node) => /疑似C/.test(node.textContent));
    button.click();
  });
  await page.waitForTimeout(600);
  const pseudo = await page.evaluate(() => ({
    hash: location.hash,
    sheets: document.querySelectorAll('#overlays .sheet').length,
  }));
  check('one tap lands on the pseudo-C view of that exact function',
    pseudo.hash === '#/function/' + address + '/pseudocode', pseudo.hash);
  check('the result sheet gets out of the way when it navigates', pseudo.sheets === 0, String(pseudo.sheets));
  await page.waitForTimeout(1200);
  const rendered = await page.evaluate(() => ({
    code: !!document.querySelector('.ui-pseudocode, .ui-empty-state, .ui-workspace-content'),
    text: (document.querySelector('.ui-pseudocode')?.textContent || '').slice(0, 40),
  }));
  check('the pseudo-C view actually renders for that function', rendered.code, rendered.text);
  const sharedHistory = await page.evaluate(() => window.__hexUi.router.canBack());
  check('direct function navigation participates in the shared navigation history',
    sharedHistory === true, String(sharedHistory));
  await page.evaluate(() => window.__hexUi.router.back());
  await page.waitForTimeout(300);
  const routeAfterBack = await page.evaluate(() => location.hash);
  check('Back returns to the workspace that was open before the function view',
    routeAfterBack === routeBeforePseudo, JSON.stringify({ before: routeBeforePseudo, after: routeAfterBack }));

  /* ── text placement on a sheet that writes prose directly ── */
  await page.evaluate(() => { window.__hexUi.router.navigate('/code'); });
  await page.waitForTimeout(250);
  await closeSheets(page);
  await page.evaluate(async (addr) => {
    const { showCandidateWhy } = await import('/js/panels.js');
    showCandidateWhy(window.__app, { addr: BigInt(addr), stars: 3, score: 42, reasons: [], strings: [] }, null);
  }, address);
  await page.waitForSelector('#overlays .sheet .scorebox', { timeout: 10000 });
  const typography = await page.evaluate(() => {
    const body = document.querySelector('#overlays .sheet:not(.parked) .sheet-body');
    const read = (node) => {
      if (!node) return null;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return { left: parseFloat(style.paddingLeft), size: parseFloat(style.fontSize), width: rect.width };
    };
    return {
      note: read(body.querySelector(':scope > .doc-p.sub')),
      bodyWidth: body.clientWidth,
      views: body.querySelectorAll('.next-views .action-btn').length,
    };
  });
  check('prose written straight into a sheet is inset, not flush with the edge',
    !!typography.note && typography.note.left >= 12, JSON.stringify(typography.note));
  check('a footnote reads as a footnote, not as body text',
    !!typography.note && typography.note.size <= 13, JSON.stringify(typography.note));
  check('a long line is capped so the eye finds the next one',
    !!typography.note && typography.note.width <= typography.bodyWidth, JSON.stringify(typography));
  check('the candidate sheet offers the same views', typography.views >= 4, String(typography.views));

  /* ── failed legacy dispatch must preserve context ─────────── */
  await page.evaluate(() => {
    if (window.__hexUi) {
      window.__hexUi.__analysisNavigationSavedRouter = window.__hexUi.router;
      window.__hexUi.router = null;
    }
  });
  const beforeFailedDispatch = await page.evaluate(() => document.querySelectorAll('#overlays .sheet:not(.parked)').length);
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('#overlays .sheet:not(.parked) .next-views .action-btn')]
      .find((node) => /根拠|evidence/i.test(node.textContent));
    if (!button) throw new Error('evidence next-view button missing');
    button.click();
  });
  await page.waitForTimeout(100);
  const afterFailedDispatch = await page.evaluate(() => document.querySelectorAll('#overlays .sheet:not(.parked)').length);
  check('a next-view with no router or legacy fallback keeps the current result open',
    beforeFailedDispatch > 0 && afterFailedDispatch === beforeFailedDispatch,
    JSON.stringify({ before: beforeFailedDispatch, after: afterFailedDispatch }));
  await page.evaluate(() => {
    if (window.__hexUi?.__analysisNavigationSavedRouter) {
      window.__hexUi.router = window.__hexUi.__analysisNavigationSavedRouter;
      delete window.__hexUi.__analysisNavigationSavedRouter;
    }
  });

  /* ── the settled-answer overlay ──────────────────────────── */
  await closeSheets(page);
  const pinned = await page.evaluate(async (addr) => {
    const [{ showPinned }, { goalFromPreset }, { VERDICT }] = await Promise.all([
      import('/js/panels.js'), import('/js/goals.js'), import('/js/evidence.js'),
    ]);
    const address = BigInt(addr);
    const top = {
      kind: 'function', addr: address, fusion: { probability: 0.93 },
      why: [{ kind: 'fact', code: 'store', factor: 3 }], sites: [], updates: [], functions: [{ addr: address }],
    };
    try {
      showPinned(window.__app, {
        goal: goalFromPreset('coins'), verdict: VERDICT.CONFIRMED, top,
        missing: [], candidates: [top], universe: 1200, changeSites: [], checked: 4,
      });
    } catch (error) { return { error: String(error && error.message || error) }; }
    await new Promise((resolve) => setTimeout(resolve, 400));
    const sheet = document.querySelector('#overlays .sheet:not(.parked)');
    if (!sheet) return { error: 'no sheet' };
    return {
      primaryRoute: sheet.querySelectorAll('.answer-primary-route').length,
      views: [...sheet.querySelectorAll('.next-views .action-btn .action-label')].map((n) => n.textContent),
      duplicateNext: /次に見るなら|What to look at next/.test(sheet.textContent || ''),
      inSheet: sheet.querySelectorAll('.in-sheet-actions .chip').length,
    };
  }, address);
  check('the settled-answer overlay renders', !pinned.error, pinned.error || '');
  check('a settled answer offers pseudo-C and the diagram for its routine',
    !!pinned.views && pinned.views.some((label) => /疑似C/.test(label)) && pinned.views.some((label) => /図/.test(label)),
    JSON.stringify(pinned.views));
  check('a settled answer has one direct route to the exact function', pinned.primaryRoute === 1, String(pinned.primaryRoute));
  check('alternate views do not duplicate the primary overview route',
    !pinned.views.some((label) => /関数の概要|Function overview/.test(label)), JSON.stringify(pinned.views));
  check('duplicate "what to look at next" wiring is removed', pinned.duplicateNext === false, String(pinned.duplicateNext));
  check('moving inside the result stays separate from leaving it', pinned.inSheet >= 2, String(pinned.inSheet));

  await page.click('#overlays .sheet:not(.parked) .answer-primary-route');
  await page.waitForTimeout(500);
  const settledDirect = await page.evaluate(() => ({
    hash: location.hash,
    sheets: document.querySelectorAll('#overlays .sheet:not(.parked)').length,
  }));
  check('one tap from a settled answer opens that exact function workspace',
    settledDirect.hash === '#/function/' + address + '/overview', settledDirect.hash);
  check('the settled result sheet closes only after navigation succeeds', settledDirect.sheets === 0, String(settledDirect.sheets));

  await page.evaluate((addr) => window.__hexUi.router.navigate('/code/' + addr), address);
  await page.waitForTimeout(700);
  await closeSheets(page);
  const point = await page.evaluate((addr) => {
    const target = BigInt(addr);
    const row = [...document.querySelectorAll('#rows .row')].find((node) =>
      node._row != null && window.__app.viewer.rowAddress(node._row) === target);
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.left + Math.min(80, r.width / 2), y: r.top + r.height / 2 };
  }, address);
  check('the function-start row is visible for the long-press regression', !!point, JSON.stringify(point));
  if (point) {
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.waitForTimeout(620);
    await page.mouse.up();
    await page.waitForTimeout(120);
    const held = await page.evaluate(() => ({
      menus: document.querySelectorAll('#overlays .menu').length,
      sheets: document.querySelectorAll('#overlays .sheet:not(.parked)').length,
      text: document.querySelector('#overlays .menu')?.textContent || '',
    }));
    check('long press opens only the shortcut menu, never the normal detail sheet',
      held.menus === 1 && held.sheets === 0, JSON.stringify(held));
    check('the long-press menu exposes the canonical function overview route',
      /関数の概要を開く|Open function overview/.test(held.text), held.text.slice(0, 120));
    await page.evaluate(() => {
      const item = [...document.querySelectorAll('#overlays .menu button, #overlays .menu [role="button"], #overlays .menu .menu-item')]
        .find((node) => /関数の概要を開く|Open function overview/.test(node.textContent || ''));
      if (!item) throw new Error('canonical function menu item missing');
      item.click();
    });
    await page.waitForTimeout(400);
    const longPressRoute = await page.evaluate(() => location.hash);
    check('the long-press shortcut lands on the same canonical function workspace',
      longPressRoute === '#/function/' + address + '/overview', longPressRoute);
  }

  /* ── the same bar on the quick function summary ──────────── */
  await closeSheets(page);
  await page.evaluate(async () => {
    const { showFunctionSummary } = await import('/js/panels.js');
    showFunctionSummary(window.__app, 0);
  });
  await page.waitForSelector('#overlays .sheet .next-views .action-btn', { timeout: 20000 });
  const summaryBar = await page.evaluate(() => [...document.querySelectorAll('#overlays .sheet .next-views .action-btn')]
    .map((node) => node.querySelector('.action-label')?.textContent || ''));
  check('the quick summary offers the same views, in the same words',
    summaryBar.some((label) => /疑似C/.test(label)) && summaryBar.some((label) => /図/.test(label)), JSON.stringify(summaryBar));

  const overflow = await page.evaluate(() => document.body.scrollWidth - document.documentElement.clientWidth);
  check('the new controls never widen the page', overflow <= 1, String(overflow));

  /* ── phone width ─────────────────────────────────────────── */
  await page.setViewportSize({ width: 375, height: 667 });
  await page.waitForTimeout(400);
  const phone = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('#overlays .sheet .next-views .action-btn')];
    const rects = buttons.map((node) => node.getBoundingClientRect());
    return {
      columns: new Set(rects.map((r) => Math.round(r.left))).size,
      height: Math.min(...rects.map((r) => Math.round(r.height))),
      inside: rects.every((r) => r.right <= document.documentElement.clientWidth + 1),
      overflow: document.body.scrollWidth - document.documentElement.clientWidth,
    };
  });
  check('on a phone the views stack in one column and stay on screen',
    phone.columns === 1 && phone.inside && phone.overflow <= 1, JSON.stringify(phone));
  check('phone-width view buttons keep a full tap target', phone.height >= 44, String(phone.height));
  check('no page errors during the whole walk', errors.length === 0, errors.slice(0, 3).join(' | '));

  await context.close();
  return state.failures;
});