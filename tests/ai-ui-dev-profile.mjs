import { openApp, reporter, run } from './ai-ui-support.mjs';

await run(async ({ browser }) => {
  const { check, state } = reporter();
  const { context, page, errors } = await openApp(browser, { width: 744, height: 1133 });

  await page.click('#ai-launcher');
  await page.waitForTimeout(200);

  const chat = await page.evaluate(() => ({
    modes: [...document.querySelectorAll('.ai-panel-head .ai-seg')].map((node) => node.dataset.value),
    profileHidden: document.querySelector('.ai-agent-profile')?.hidden,
    policyHidden: document.querySelector('.ai-dev-policy')?.hidden,
  }));
  check('Chat/Agent remain the only top-level modes', JSON.stringify(chat.modes) === JSON.stringify(['chat', 'agent']), JSON.stringify(chat.modes));
  check('Dev controls stay out of Chat mode', chat.profileHidden === true && chat.policyHidden === true, JSON.stringify(chat));

  await page.evaluate(() => document.querySelector('.ai-panel-head .ai-seg[data-value="agent"]').click());
  await page.waitForTimeout(100);
  const standard = await page.evaluate(() => ({
    profileHidden: document.querySelector('.ai-agent-profile').hidden,
    profiles: [...document.querySelectorAll('.ai-agent-profile .ai-seg')].map((node) => node.dataset.value),
    selected: document.querySelector('.ai-agent-profile .ai-seg.active')?.dataset.value,
    policyHidden: document.querySelector('.ai-dev-policy').hidden,
    scope: document.querySelector('.ai-scope-chip').textContent,
  }));
  check('Agent exposes Standard/Dev for the current all-admin provider', !standard.profileHidden && JSON.stringify(standard.profiles) === JSON.stringify(['standard', 'dev']), JSON.stringify(standard));
  check('Standard stays selected by default and keeps Dev policy hidden', standard.selected === 'standard' && standard.policyHidden === true, JSON.stringify(standard));
  check('Standard keeps the existing Auto analysis scope', /自動|Auto/.test(standard.scope || ''), standard.scope);

  await page.evaluate(() => document.querySelector('.ai-agent-profile .ai-seg[data-value="dev"]').click());
  await page.waitForTimeout(100);
  const dev = await page.evaluate(() => ({
    profile: document.querySelector('.ai-agent-profile .ai-seg.active')?.dataset.value,
    policyHidden: document.querySelector('.ai-dev-policy').hidden,
    policy: document.querySelector('.ai-dev-policy .ai-seg.active')?.dataset.value,
    scope: document.querySelector('.ai-scope-chip').textContent,
    data: {
      profile: document.getElementById('ai-panel').dataset.agentProfile,
      policy: document.getElementById('ai-panel').dataset.decisionPolicy,
      scope: document.getElementById('ai-panel').dataset.analysisScope,
    },
  }));
  check('Dev exposes Normal/YOLO without becoming a third top-level mode', dev.profile === 'dev' && !dev.policyHidden && dev.policy === 'normal', JSON.stringify(dev));
  check('Dev starts with analysisScope none', /なし|None/.test(dev.scope || '') && dev.data.scope === 'none', JSON.stringify(dev));

  await page.evaluate(() => document.querySelector('.ai-dev-policy .ai-seg[data-value="yolo"]').click());
  await page.fill('.ai-input', 'Round 1 run');
  await page.evaluate(() => document.querySelector('.ai-composer').requestSubmit());
  await page.waitForTimeout(250);
  const runState = await page.evaluate(() => {
    const run = window.__hexAi.dev.settings.lastRun;
    return run && {
      profile: run.agentProfile,
      policy: run.decisionPolicy,
      initial: run.analysisScope.initial,
      expansionPolicy: run.analysisScope.expansionPolicy,
      status: run.status,
      hasRunId: !!run.runId,
      hasSessionKey: !!run.supervisorSessionKey,
    };
  });
  check('Dev UI starts the separate DevSupervisor path with persisted choices', runState?.profile === 'dev' && runState.policy === 'yolo' && runState.initial === 'none' && runState.expansionPolicy === 'agent' && runState.status === 'ACTIVE', JSON.stringify(runState));
  check('Dev run has stable seed identities', runState?.hasRunId === true && runState.hasSessionKey === true, JSON.stringify(runState));

  await page.evaluate(() => document.querySelector('.ai-agent-profile .ai-seg[data-value="standard"]').click());
  await page.waitForTimeout(100);
  const back = await page.evaluate(() => ({
    profile: document.getElementById('ai-panel').dataset.agentProfile,
    policyHidden: document.querySelector('.ai-dev-policy').hidden,
    scope: document.querySelector('.ai-scope-chip').textContent,
  }));
  check('switching back to Standard removes Dev-only controls and restores Standard scope', back.profile === 'standard' && back.policyHidden === true && /自動|Auto/.test(back.scope || ''), JSON.stringify(back));
  check('Dev profile wiring has no browser errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  await context.close();
  return state.failures;
});
