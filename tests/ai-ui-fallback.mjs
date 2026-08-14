/*
 * The offline guarantee.
 *
 * Every other assistant suite injects a stub engine. This one uses the real
 * one with no AI core in the checkout and no reachable provider — the state a
 * user is in on a plane, behind a firewall, or during a core outage — and
 * requires that the assistant still answers from deterministic Hex analysis
 * instead of apologising.
 */
import { openApp, reporter, run, ask } from './ai-ui-support.mjs';

const settled = async (page, timeout) => page.waitForFunction(() => {
  const node = [...document.querySelectorAll('.ai-turn-assistant')].pop();
  return !!node && node.dataset.status !== 'running';
}, null, { timeout });

await run(async ({ browser }) => {
  const { check, state } = reporter();
  const { context, page, errors } = await openApp(browser, { width: 1440, height: 900, sample: true });

  await page.click('#ai-launcher');
  await page.waitForTimeout(150);

  await ask(page, 'この関数は何をしている？');
  await settled(page, 60000);
  const chat = await page.evaluate(() => {
    const node = [...document.querySelectorAll('.ai-turn-assistant')].pop();
    const session = window.__hexAi.session;
    const last = session.turns[session.turns.length - 1];
    return {
      status: node.dataset.status,
      text: last.response ? last.response.answerText : '',
      evidence: last.response ? last.response.evidence : [],
      actions: last.response ? last.response.actions.map((a) => a.kind) : [],
    };
  });
  check('chat answers with no core and no provider', chat.status === 'done' && chat.text.length > 0, chat.status);
  check('the answer names the function and its real address', /0x[0-9a-f]+/.test(chat.text) && /命令|instructions/.test(chat.text), chat.text.slice(0, 80));
  check('it says plainly that no model was involved', /接続できない|unreachable/.test(chat.text), chat.text.slice(-60));
  check('the facts it prints are carried as evidence, marked verified',
    chat.evidence.length > 0 && chat.evidence[0].status === 'verified' && chat.evidence[0].sourceTool === 'hex-disassembler',
    JSON.stringify(chat.evidence[0] && { s: chat.evidence[0].status, t: chat.evidence[0].sourceTool }));
  check('the answer still leads into the code', chat.actions.includes('open-function'), JSON.stringify(chat.actions));

  await page.evaluate(() => window.__hexAi.session.setMode('agent'));
  await ask(page, '値が増える場所を探して');
  await settled(page, 180000);
  const agent = await page.evaluate(() => {
    const node = [...document.querySelectorAll('.ai-turn-assistant')].pop();
    const session = window.__hexAi.session;
    const last = session.turns[session.turns.length - 1];
    return {
      status: node.dataset.status,
      activity: [...node.querySelectorAll('.ai-activity-row')].map((n) => n.textContent),
      evidence: last.response ? last.response.evidence.length : 0,
      verified: last.response ? last.response.evidence.filter((e) => e.status === 'verified').length : 0,
      hypotheses: last.response ? last.response.hypotheses.length : 0,
      followupText: [...node.querySelectorAll('.ai-followups .ai-chip')].map((n) => n.textContent),
      checks: [...node.querySelectorAll('.ai-check')].map((n) => n.textContent),
      sources: last.response ? [...new Set(last.response.evidence.map((e) => e.sourceTool))] : [],
    };
  });
  check('agent mode runs the deterministic planner locally', agent.status === 'done' && agent.evidence > 0, JSON.stringify({ s: agent.status, e: agent.evidence }));
  check('progress is reported as steps with counts', agent.activity.length >= 3 && agent.activity.some((row) => /\d/.test(row)), JSON.stringify(agent.activity));
  check('candidates come from the deterministic planner, not from prose',
    agent.sources.includes('deterministic-goal-planner'), JSON.stringify(agent.sources));
  check('a hypothesis is offered with its open questions', agent.hypotheses === 1 && agent.checks.length > 0, JSON.stringify(agent.checks.slice(0, 2)));

  /* Machine codes must never reach the user as chip labels. */
  const raw = [...agent.followupText, ...agent.checks].filter((text) => /^[?\s]*[a-z][a-z0-9-]*$/.test(text.trim()));
  check('no raw missing-evidence code is shown as a label', raw.length === 0, JSON.stringify(raw));

  check('no page errors on the offline path', errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
  return state.failures;
});
