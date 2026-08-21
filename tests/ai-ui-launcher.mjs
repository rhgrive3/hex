/*
 * Launcher and panel shell: reachability, layout per width, focus, and the
 * rule that matters most — opening the assistant must never make the code
 * unreachable.
 */
import { openApp, reporter, run, stubEngine, ask } from './ai-ui-support.mjs';

const VIEWPORTS = [
  ['desktop', 1440, 900, 'dock'],
  ['tablet-portrait', 744, 1133, 'sheet'],
  ['tablet-landscape', 1133, 744, 'dock'],
  ['phone', 390, 844, 'full'],
];

await run(async ({ browser }) => {
  const { check, state } = reporter();

  for (const [name, width, height, expectedLayout] of VIEWPORTS) {
    const { context, page, errors } = await openApp(browser, { width, height });

    const closed = await page.evaluate(() => {
      const launcher = document.getElementById('ai-launcher');
      const rect = launcher.getBoundingClientRect();
      const panel = document.getElementById('ai-panel');
      return {
        expanded: launcher.getAttribute('aria-expanded'),
        label: launcher.getAttribute('aria-label') || '',
        controls: launcher.getAttribute('aria-controls'),
        tag: launcher.tagName,
        rect: { w: rect.width, h: rect.height, right: rect.right, bottom: rect.bottom },
        panelHidden: panel.hidden,
        nav: [...document.querySelectorAll('.ui-bottom-nav .ui-nav-item')]
          .map((node) => node.getBoundingClientRect().toJSON()),
      };
    });
    check(`${name}: launcher is a real button with a name`, closed.tag === 'BUTTON' && closed.label.length > 0 && closed.controls === 'ai-panel');
    check(`${name}: launcher is a 44px+ target inside the viewport`,
      closed.rect.w >= 44 && closed.rect.h >= 44 && closed.rect.right <= width + 1 && closed.rect.bottom <= height + 1,
      JSON.stringify(closed.rect));
    check(`${name}: the panel is closed until asked for`, closed.panelHidden === true && closed.expanded === 'false');
    const overlapsNav = closed.nav.some((item) => !(item.right < width - 48 - 8 || item.top > closed.rect.bottom || item.bottom < closed.rect.top));
    check(`${name}: launcher does not sit on top of the primary navigation`, !overlapsNav || width >= 900, JSON.stringify(closed.nav.slice(-1)));

    await page.click('#ai-launcher');
    await page.waitForTimeout(280);
    const open = await page.evaluate(() => {
      const panel = document.getElementById('ai-panel');
      const rect = panel.getBoundingClientRect();
      const app = document.getElementById('app').getBoundingClientRect();
      const segmentedValues = (root) => new Set([...root.querySelectorAll('.ai-seg')].map((node) => node.dataset.value));
      const modeToggle = [...panel.querySelectorAll('.ai-panel-head .ai-segmented')]
        .some((root) => { const values = segmentedValues(root); return values.has('chat') && values.has('agent'); });
      const styleToggle = [...panel.querySelectorAll('.ai-context-bar .ai-segmented')]
        .some((root) => { const values = segmentedValues(root); return values.has('beginner') && values.has('analyst'); });
      return {
        hidden: panel.hidden,
        layout: panel.dataset.layout,
        expanded: document.getElementById('ai-launcher').getAttribute('aria-expanded'),
        focus: document.activeElement && document.activeElement.className,
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height, right: rect.right, bottom: rect.bottom },
        appRight: app.right,
        docked: document.documentElement.classList.contains('ai-docked'),
        role: panel.getAttribute('role'),
        modal: panel.getAttribute('aria-modal'),
        composer: !!panel.querySelector('.ai-input'),
        modeToggle,
        styleToggle,
      };
    });
    check(`${name}: opens as the ${expectedLayout} layout`, open.hidden === false && open.layout === expectedLayout, open.layout);
    check(`${name}: panel stays inside the viewport`, open.rect.right <= width + 1 && open.rect.bottom <= height + 1 && open.rect.x >= -1, JSON.stringify(open.rect));
    check(`${name}: focus moves to the composer`, /ai-input/.test(open.focus || ''), String(open.focus));
    check(`${name}: mode and style toggles are both present`, open.modeToggle && open.styleToggle && open.composer);
    check(`${name}: launcher reports the open state`, open.expanded === 'true');
    if (expectedLayout === 'dock') {
      check(`${name}: docked panel shrinks the workspace instead of covering it`, open.docked === true);
    } else {
      check(`${name}: overlay layouts are announced as modal`, open.role === 'dialog' && open.modal === 'true');
    }

    /* The point of the whole layout: the code must remain usable. */
    const code = await page.evaluate(() => {
      const panel = document.getElementById('ai-panel').getBoundingClientRect();
      const viewport = document.getElementById('viewport').getBoundingClientRect();
      const covered = !(viewport.right <= panel.left || viewport.left >= panel.right || viewport.bottom <= panel.top || viewport.top >= panel.bottom);
      return { width: viewport.width, height: viewport.height, covered };
    });
    if (expectedLayout === 'dock') {
      check(`${name}: the disassembly keeps real width beside the panel`, code.width > 300 && !code.covered, JSON.stringify(code));
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(220);
    const afterEscape = await page.evaluate(() => ({
      hidden: document.getElementById('ai-panel').hidden,
      focus: document.activeElement && document.activeElement.id,
      docked: document.documentElement.classList.contains('ai-docked'),
    }));
    check(`${name}: Escape closes and returns focus to the launcher`,
      afterEscape.hidden === true && afterEscape.focus === 'ai-launcher' && !afterEscape.docked, JSON.stringify(afterEscape));

    check(`${name}: no page errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
    await context.close();
  }

  /* An answer that lands while the panel is closed must be findable later. */
  {
    const { context, page } = await openApp(browser, { width: 1440, height: 900 });
    await stubEngine(page, { answer: 'background answer' }, { hang: true });
    await page.click('#ai-launcher');
    await page.waitForTimeout(150);
  await ask(page, 'これは何？');
  await page.waitForTimeout(120);
  const runningRing = await page.evaluate(() => {
    const launcher = document.getElementById('ai-launcher');
    const ring = getComputedStyle(launcher, '::after');
    return {
      state: launcher.dataset.state,
      busy: launcher.getAttribute('aria-busy'),
      top: parseFloat(ring.top),
      right: parseFloat(ring.right),
      bottom: parseFloat(ring.bottom),
      left: parseFloat(ring.left),
      borderTopWidth: parseFloat(ring.borderTopWidth),
      borderTopStyle: ring.borderTopStyle,
      animationName: ring.animationName,
      pointerEvents: ring.pointerEvents,
    };
  });
  check('running launcher uses a complete inset ring instead of a clipped missing segment',
    runningRing.state === 'running' && runningRing.busy === 'true' &&
    runningRing.top >= 0 && runningRing.right >= 0 && runningRing.bottom >= 0 && runningRing.left >= 0 &&
    runningRing.borderTopWidth > 0 && runningRing.borderTopStyle === 'solid' &&
    runningRing.animationName === 'ai-launcher-spin' && runningRing.pointerEvents === 'none',
    JSON.stringify(runningRing));
  await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    await page.evaluate(() => window.__hexStub.resolve());
    await page.waitForTimeout(300);
    const badge = await page.evaluate(() => {
      const launcher = document.getElementById('ai-launcher');
      return { unread: launcher.dataset.unread, state: launcher.dataset.state, hidden: document.getElementById('ai-panel').hidden };
    });
    check('an answer that arrives while closed marks the launcher unread', badge.unread === '1' && badge.state === 'attention', JSON.stringify(badge));
    await page.click('#ai-launcher');
    await page.waitForTimeout(200);
    const cleared = await page.evaluate(() => document.getElementById('ai-launcher').dataset.unread);
    check('opening the panel clears the unread marker', !cleared, String(cleared));
    await context.close();
  }

  /* Rotating a tablet must re-pick the layout rather than strand the panel. */
  {
    const { context, page } = await openApp(browser, { width: 1133, height: 744 });
    await page.click('#ai-launcher');
    await page.waitForTimeout(200);
    await page.setViewportSize({ width: 744, height: 1133 });
    await page.waitForTimeout(400);
    const rotated = await page.evaluate(() => {
      const panel = document.getElementById('ai-panel');
      const rect = panel.getBoundingClientRect();
      return { layout: panel.dataset.layout, right: rect.right, bottom: rect.bottom };
    });
    check('rotation re-picks the layout and keeps the panel on screen',
      rotated.layout === 'sheet' && rotated.right <= 745 && rotated.bottom <= 1134, JSON.stringify(rotated));
    await context.close();
  }

  return state.failures;
});
