/*
 * UI <-> AI core integration.
 *
 * The UI loads the core (js/ai/runtime.js) through a dynamic import so the
 * workbench keeps working without it. This suite covers the other half: when
 * the core IS present, a real turn must run through it — the UI's context
 * adapter feeding the core's tools, the core's result rendering in the panel —
 * with no provider reachable, which is exactly the degraded path a user hits
 * offline.
 *
 * Skips (does not fail) when the core is not part of this checkout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openApp, reporter, run, ask, ROOT } from './ai-ui-support.mjs';

const CORE = path.join(ROOT, 'js/ai/runtime.js');
if (!fs.existsSync(CORE)) {
  console.log('skip  AI core (js/ai/runtime.js) is not in this checkout; UI-core integration was not executed.');
  if (process.env.CI && process.env.REQUIRE_AI_CORE) process.exit(1);
} else {
  await run(async ({ browser }) => {
    const { check, state } = reporter();
    const { context, page, errors } = await openApp(browser, { width: 1440, height: 900, sample: true });

    await page.click('#ai-launcher');
    await page.waitForTimeout(150);

    const loaded = await page.evaluate(async () => {
      const runtime = await window.__hexAi.engine.runtime();
      return {
        present: !!runtime,
        hasTurn: typeof runtime?.turn === 'function',
        hasProposals: !!runtime?.proposalStore,
        engineIsCore: window.__hexAi.session.engine === window.__hexAi.engine,
      };
    });
    check('the UI loads the real AI core runtime', loaded.present && loaded.hasTurn, JSON.stringify(loaded));
    check('the core exposes the proposal store the approval UI needs', loaded.hasProposals);

    /* No provider is reachable from the test server, so the core must fall back
       to its deterministic planner rather than failing the turn. */
    await ask(page, 'この関数は何をしている？');
    await page.waitForFunction(() => {
      const turn = [...document.querySelectorAll('.ai-turn-assistant')].pop();
      return turn && turn.dataset.status !== 'running';
    }, null, { timeout: 60000 });

    const turn = await page.evaluate(() => {
      const node = [...document.querySelectorAll('.ai-turn-assistant')].pop();
      const session = window.__hexAi.session;
      const last = session.turns[session.turns.length - 1];
      return {
        status: node.dataset.status,
        text: node.textContent.slice(0, 120),
        answered: !!(last.response && last.response.answerText),
        unknownFields: last.response ? last.response.unknownFields : null,
        sessionId: last.response ? last.response.sessionId : null,
        activity: [...node.querySelectorAll('.ai-activity-row')].map((n) => n.textContent).slice(0, 4),
      };
    });
    check('a chat turn completes through the core without a provider', turn.status === 'done' && turn.answered, JSON.stringify(turn));
    check('the core result contains no field this UI cannot render',
      Array.isArray(turn.unknownFields) && turn.unknownFields.length === 0, JSON.stringify(turn.unknownFields));
    check('the core returns a session id the UI keeps for the next turn', !!turn.sessionId, String(turn.sessionId));

    /* Agent mode drives the deterministic planner over the real context
       adapter: strings, program index and semantic analysis all come from the
       app through js/ai/ui/hex-context.js. */
    await page.evaluate(() => window.__hexAi.session.setMode('agent'));
    await ask(page, '値が増える場所を探して');
    await page.waitForFunction(() => {
      const node = [...document.querySelectorAll('.ai-turn-assistant')].pop();
      return node && node.dataset.status !== 'running';
    }, null, { timeout: 120000 });

    const agent = await page.evaluate(() => {
      const node = [...document.querySelectorAll('.ai-turn-assistant')].pop();
      const session = window.__hexAi.session;
      const last = session.turns[session.turns.length - 1];
      return {
        status: node.dataset.status,
        mode: node.dataset.mode,
        activity: [...node.querySelectorAll('.ai-activity-row')].map((n) => n.textContent),
        usage: last.response ? last.response.usage : null,
        evidence: last.response ? last.response.evidence.length : -1,
      };
    });
    check('an agent turn completes through the core planner', agent.status === 'done' && agent.mode === 'agent', JSON.stringify(agent.status));
    check('the core reports progress the panel can show', agent.activity.length > 0, JSON.stringify(agent.activity.slice(0, 3)));
    check('the core reports what the investigation cost', !!agent.usage, JSON.stringify(agent.usage));

    check('no page errors while the core is driving', errors.length === 0, errors.slice(0, 3).join(' | '));
    await context.close();
    return state.failures;
  });
}
