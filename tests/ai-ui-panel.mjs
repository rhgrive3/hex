/*
 * Panel behaviour: modes, styles, scope, activity, evidence navigation,
 * cancel/retry, and the limits that keep a long session cheap to render.
 */
import { openApp, reporter, run, stubEngine, ask, closeSheets } from './ai-ui-support.mjs';

const ANSWER = {
  answer: '結論から言うと、この関数が XP を書き換えています。\n\n- `STR W1, [X0,#0xC030]` が加算後の値を書きます\n- 呼び出し元は報酬処理です',
  confidence: 0.94,
  evidence: [
    {
      id: 'ev_a', kind: 'field-write', status: 'verified', title: 'フィールド書き込み',
      summary: 'read-modify-write on 0xC030', address: '0x100000004', functionAddress: '0x100000000',
      functionName: 'sample_start', sourceTool: 'verify_field_update',
    },
    { id: 'ev_b', kind: 'candidate', status: 'supported', title: '候補', functionAddress: '0x100000000' },
    { id: 'ev_c', kind: 'xref', status: 'hypothesis', title: '呼び出し元', functionAddress: '0x100000000' },
    { id: 'ev_d', kind: 'xref', status: 'unknown', title: '未確認の参照', functionAddress: '0x100000000' },
  ],
  hypotheses: [{
    id: 'hyp_1', claim: 'XP 更新ハンドラ', confidence: 0.87, status: 'supported',
    supportEvidenceIds: ['ev_a'], contradictionEvidenceIds: [], missingEvidence: ['保存経路は未確認'],
  }],
  actions: [{ kind: 'open-function', target: '0x100000000', label: '関数を開く' }],
  followups: ['保存処理を追う'],
};

await run(async ({ browser }) => {
  const { check, state } = reporter();
  const { context, page, errors } = await openApp(browser, { width: 1440, height: 900, sample: true });

  const base = await page.evaluate(() => ({ hash: location.hash, screen: !!document.querySelector('#viewport') }));
  check('opening a file lands on the code workspace, not a question screen', base.hash.startsWith('#/code'), base.hash);

  const real = await page.evaluate(() => {
    const region = window.__app.codeRegion();
    return { fn: '0x' + region.vmAddr.toString(16), insn: '0x' + (region.vmAddr + 8n).toString(16) };
  });
  for (const item of ANSWER.evidence) {
    item.functionAddress = real.fn;
    if (item.address) item.address = real.insn;
  }
  ANSWER.actions[0].target = real.fn;

  await stubEngine(page, ANSWER, { activity: [
    { label: '文字列を検索', detail: '3' },
    { label: '文字列を検索', detail: '13' },
    { label: '参照をたどる', detail: '6' },
  ] });
  await page.click('#ai-launcher');
  await page.waitForTimeout(200);

  const emptyState = await page.evaluate(() => ({
    suggestions: document.querySelectorAll('.ai-empty-suggestions .ai-chip').length,
    scope: document.querySelector('.ai-scope-chip').textContent,
    context: document.querySelector('.ai-context-chip').textContent,
  }));
  check('an empty conversation offers a starting point', emptyState.suggestions >= 2, String(emptyState.suggestions));
  check('the context bar names the scope and the current context', /自動/.test(emptyState.scope) && emptyState.context.length > 0, emptyState.scope + ' / ' + emptyState.context);

  await ask(page, 'この関数は何をしている？');
  await page.waitForTimeout(300);

  const answered = await page.evaluate(() => {
    const turns = [...document.querySelectorAll('.ai-turn')];
    const assistant = document.querySelector('.ai-turn-assistant');
    return {
      turns: turns.length,
      user: document.querySelector('.ai-turn-user')?.textContent,
      status: assistant?.dataset.status,
      paragraphs: assistant?.querySelectorAll('.ai-answer-p').length,
      bullets: assistant?.querySelectorAll('.ai-answer-list li').length,
      inlineCode: assistant?.querySelectorAll('.ai-inline-code').length,
      hypothesis: assistant?.querySelector('.ai-hypothesis-claim')?.textContent,
      checks: assistant?.querySelectorAll('.ai-check').length,
      actions: [...(assistant?.querySelectorAll('.ai-actions .ai-chip') || [])].map((n) => n.textContent),
      followups: [...(assistant?.querySelectorAll('.ai-followups .ai-chip') || [])].map((n) => n.textContent),
      confidence: assistant?.querySelector('.ai-confidence-text')?.textContent,
      activity: [...(assistant?.querySelectorAll('.ai-activity-row') || [])].map((n) => n.textContent),
      statuses: [...(assistant?.querySelectorAll('.ai-status') || [])].map((n) => n.dataset.status),
      marks: [...(assistant?.querySelectorAll('.ai-status-mark') || [])].map((n) => n.textContent),
    };
  });
  check('the question and the answer are both in the transcript', answered.turns === 2 && /この関数は何をしている/.test(answered.user || ''));
  check('answer prose renders as paragraphs, bullets and inline code', answered.paragraphs >= 1 && answered.bullets === 2 && answered.inlineCode >= 1, JSON.stringify(answered));
  check('the hypothesis card carries support and open questions', /XP 更新ハンドラ/.test(answered.hypothesis || '') && answered.checks >= 2, String(answered.checks));
  check('the answer ends in an action and an open question', answered.actions.length >= 1 && answered.followups.length === 1, JSON.stringify(answered.actions));
  check('a model score is shown as stars, never as a percentage', /\/5/.test(answered.confidence || '') && !/%/.test(answered.confidence || ''), String(answered.confidence));
  check('evidence state is carried by a glyph as well as colour', answered.marks.length > 0 && answered.marks.every((mark) => mark.trim().length > 0), JSON.stringify(answered.marks));

  /* Chat mode keeps the tool timeline out of the way. */
  check('chat mode does not show an agent timeline', answered.activity.length === 0, JSON.stringify(answered.activity));

  const modeSwitch = await page.evaluate(() => {
    document.querySelectorAll('.ai-panel-head .ai-seg')[1].click();
    return { mode: window.__hexAi.session.mode, pressed: document.querySelectorAll('.ai-panel-head .ai-seg')[1].getAttribute('aria-selected') };
  });
  check('the Agent toggle switches the session mode', modeSwitch.mode === 'agent' && modeSwitch.pressed === 'true', JSON.stringify(modeSwitch));

  await ask(page, 'XPが増える場所を探して');
  await page.waitForTimeout(300);
  const agentTurn = await page.evaluate(() => {
    const assistant = [...document.querySelectorAll('.ai-turn-assistant')].pop();
    return {
      mode: assistant.dataset.mode,
      activity: [...assistant.querySelectorAll('.ai-activity-row')].map((n) => n.textContent),
      askedMode: window.__hexStub.calls[window.__hexStub.calls.length - 1].mode,
    };
  });
  check('agent mode reports factual progress, collapsed by label', agentTurn.mode === 'agent' && agentTurn.activity.length === 2, JSON.stringify(agentTurn.activity));
  check('the engine receives the selected mode', agentTurn.askedMode === 'agent');

  /* Beginner keeps proof one disclosure away; Analyst front-loads it. */
  const beginnerFold = await page.evaluate(() => {
    const assistant = [...document.querySelectorAll('.ai-turn-assistant')].pop();
    return { fold: !!assistant.querySelector('.ai-evidence-fold'), open: assistant.querySelector('.ai-evidence-fold')?.open };
  });
  check('beginner answers fold the evidence behind "why"', beginnerFold.fold === true && !beginnerFold.open, JSON.stringify(beginnerFold));

  await page.evaluate(() => [...document.querySelectorAll('.ai-context-bar .ai-seg')].find((n) => n.dataset.value === 'analyst').click());
  await ask(page, '同じ質問を解析者向けに');
  await page.waitForTimeout(300);
  const analystTurn = await page.evaluate(() => {
    const assistant = [...document.querySelectorAll('.ai-turn-assistant')].pop();
    return {
      style: assistant.dataset.style,
      fold: !!assistant.querySelector('.ai-evidence-fold'),
      evidenceCards: assistant.querySelectorAll('.ai-evidence').length,
      askedStyle: window.__hexStub.calls[window.__hexStub.calls.length - 1].style,
    };
  });
  check('analyst answers show evidence without a disclosure', analystTurn.style === 'analyst' && !analystTurn.fold && analystTurn.evidenceCards >= 3, JSON.stringify(analystTurn));
  check('the engine receives the selected style', analystTurn.askedStyle === 'analyst');

  /* Scope */
  const scoped = await page.evaluate(async () => {
    window.__hexAi.session.setScope('binary');
    document.querySelector('.ai-scope-chip').click();
    return { label: document.querySelector('.ai-scope-chip').textContent };
  });
  await page.keyboard.press('Escape');
  await ask(page, 'スコープの確認');
  await page.waitForTimeout(250);
  const scopeUsed = await page.evaluate(() => window.__hexStub.calls[window.__hexStub.calls.length - 1].scope);
  check('the scope control reaches the engine', scopeUsed === 'binary' && /バイナリ全体/.test(scoped.label), scopeUsed + ' / ' + scoped.label);

  /* Evidence -> code in one tap. */
  const navigated = await page.evaluate(async () => {
    const assistant = [...document.querySelectorAll('.ai-turn-assistant')].pop();
    const button = [...assistant.querySelectorAll('.ai-evidence-actions .ai-chip')].find((n) => /命令へ/.test(n.textContent));
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { hash: location.hash, selected: window.__app.store.get('selectedRow') };
  });
  check('an evidence card jumps to the instruction in one tap', navigated.hash.includes('/code/') && navigated.selected >= 0, JSON.stringify(navigated));
  await closeSheets(page);

  /* Cancel and retry. */
  await stubEngine(page, { answer: 'never arrives' }, { hang: true });
  await ask(page, '止める練習');
  const cancelled = await page.evaluate(async () => {
    const stop = document.querySelector('.ai-stop');
    const visible = !stop.hidden;
    stop.click();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const assistant = [...document.querySelectorAll('.ai-turn-assistant')].pop();
    return { visible, status: assistant.dataset.status, busy: window.__hexAi.session.busy, stopHidden: document.querySelector('.ai-stop').hidden };
  });
  check('a running turn can be stopped and says so', cancelled.visible && cancelled.status === 'cancelled' && !cancelled.busy && cancelled.stopHidden, JSON.stringify(cancelled));

  await stubEngine(page, {}, { fail: 'provider_error' });
  await ask(page, '失敗する質問');
  await page.waitForTimeout(250);
  const failed = await page.evaluate(() => {
    const assistant = [...document.querySelectorAll('.ai-turn-assistant')].pop();
    return {
      status: assistant.dataset.status,
      role: assistant.querySelector('.ai-error')?.getAttribute('role'),
      detail: assistant.querySelector('.ai-error-detail')?.textContent,
      retry: !!assistant.querySelector('.ai-error .ai-chip'),
    };
  });
  check('a failure is stated with its reason and a retry', failed.status === 'error' && failed.role === 'alert' && /provider_error/.test(failed.detail || '') && failed.retry, JSON.stringify(failed));

  await stubEngine(page, { answer: '二回目は成功しました' });
  const retried = await page.evaluate(async () => {
    const assistant = [...document.querySelectorAll('.ai-turn-assistant')].pop();
    assistant.querySelector('.ai-error .ai-chip').click();
    await new Promise((resolve) => setTimeout(resolve, 350));
    const last = [...document.querySelectorAll('.ai-turn-assistant')].pop();
    return { status: last.dataset.status, text: last.textContent, question: window.__hexStub.calls[0].question };
  });
  check('retry re-asks the same question and replaces the failure', retried.status === 'done' && /二回目は成功/.test(retried.text) && retried.question === '失敗する質問', JSON.stringify({ s: retried.status, q: retried.question }));

  /* Volume: a long answer with a large evidence list must stay cheap. */
  const heavy = {
    answer: Array.from({ length: 60 }, (_, i) => `行 ${i}: この関数は 0x${(0x100000000 + i * 4).toString(16)} を読み書きします。`).join('\n\n'),
    evidence: Array.from({ length: 120 }, (_, i) => ({
      id: 'ev' + i, status: 'supported', title: '根拠 ' + i, functionAddress: '0x100000000',
    })),
  };
  await stubEngine(page, heavy);
  await ask(page, '大量の根拠');
  await page.waitForTimeout(400);
  const volume = await page.evaluate(() => {
    const assistant = [...document.querySelectorAll('.ai-turn-assistant')].pop();
    return {
      cards: assistant.querySelectorAll('.ai-evidence').length,
      more: !!assistant.querySelector('.ai-more'),
      nodes: assistant.querySelectorAll('*').length,
      panelNodes: document.getElementById('ai-panel').querySelectorAll('*').length,
      overflow: document.body.scrollWidth - document.documentElement.clientWidth,
    };
  });
  check('120 evidence items render as a few cards plus a disclosure', volume.cards <= 4 && volume.more, JSON.stringify(volume));
  check('one heavy turn stays under a few hundred DOM nodes', volume.nodes < 400, String(volume.nodes));
  check('the panel never causes horizontal page overflow', volume.overflow <= 1, String(volume.overflow));

  const expanded = await page.evaluate(async () => {
    const assistant = [...document.querySelectorAll('.ai-turn-assistant')].pop();
    const details = assistant.querySelector('.ai-more');
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { cards: assistant.querySelectorAll('.ai-evidence').length, note: !!assistant.querySelector('.ai-note') };
  });
  check('expanding fills in the rest, capped with an honest note', expanded.cards > 4 && expanded.cards <= 41 && expanded.note, JSON.stringify(expanded));

  /* A schema this build does not fully know must say so. */
  await stubEngine(page, { answer: '新しい形式', futureField: { x: 1 } });
  await ask(page, '未知のフィールド');
  await page.waitForTimeout(250);
  const forward = await page.evaluate(() => {
    const assistant = [...document.querySelectorAll('.ai-turn-assistant')].pop();
    return { status: assistant.dataset.status, note: assistant.querySelector('.ai-note')?.textContent || '' };
  });
  check('an unknown schema field is reported, not swallowed', forward.status === 'done' && /futureField/.test(forward.note), forward.note);

  /* Omnibox: "?" is the assistant, everything else is navigation. */
  const omnibox = await page.evaluate(async () => {
    const input = document.querySelector('.ui-global-command');
    input.value = '? コインが増えるのはどこ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const hint = document.querySelector('.ui-command-hint').textContent;
    document.querySelector('.ui-command-center').requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { hint, question: window.__hexStub.calls[window.__hexStub.calls.length - 1].question, open: !document.getElementById('ai-panel').hidden };
  });
  check('the omnibox routes a "?" question to the assistant', /AI/.test(omnibox.hint) && omnibox.question === 'コインが増えるのはどこ' && omnibox.open, JSON.stringify(omnibox));

  const keyboard = await page.evaluate(async () => {
    document.querySelector('.ai-input').focus();
    return { before: document.activeElement.className };
  });
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(120);
  const focused = await page.evaluate(() => document.activeElement.className);
  check('Cmd/Ctrl+K reaches the omnibox from inside the panel', /ui-global-command/.test(focused), keyboard.before + ' -> ' + focused);

  /* Contextual entry points: one row in the host menu, verbs one level down. */
  const contextMenu = await page.evaluate(async () => {
    const { instructionMenu } = await import('/js/panels.js');
    window.__app.viewer.select(2, false);
    instructionMenu(window.__app, 2, 200, 200);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const items = [...document.querySelectorAll('#overlays .menu button')].map((n) => n.textContent);
    const askRow = [...document.querySelectorAll('#overlays .menu button')].find((n) => /AI に聞く/.test(n.textContent));
    askRow.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const verbs = [...document.querySelectorAll('#overlays .menu button')].map((n) => n.textContent);
    return { first: items[0], aiRows: items.filter((t) => /AI に聞く/.test(t)).length, verbs };
  });
  check('the instruction menu gains exactly one AI row, placed first',
    /AI に聞く/.test(contextMenu.first || '') && contextMenu.aiRows === 1, JSON.stringify(contextMenu.first));
  check('the AI row opens instruction verbs with the target already filled in',
    contextMenu.verbs.length === 3 && contextMenu.verbs.some((t) => /この命令を説明/.test(t)) && contextMenu.verbs.some((t) => /この値を追って/.test(t)),
    JSON.stringify(contextMenu.verbs));

  const asked = await page.evaluate(async () => {
    const verb = [...document.querySelectorAll('#overlays .menu button')].find((n) => /この命令を説明/.test(n.textContent));
    verb.click();
    await new Promise((resolve) => setTimeout(resolve, 350));
    const call = window.__hexStub.calls[window.__hexStub.calls.length - 1];
    return { question: call.question, scope: call.scope, open: !document.getElementById('ai-panel').hidden };
  });
  check('a contextual verb asks a complete question in the selection scope',
    /0x[0-9a-f]+/.test(asked.question) && asked.scope === 'selection' && asked.open, JSON.stringify(asked));

  /* Several chats: New chat, the history menu, and what the engine is told. */
  await closeSheets(page);
  await stubEngine(page, { answer: '一つ目のチャットの答え' });
  await page.evaluate(() => document.querySelector('.ai-new-chat').click());
  await page.waitForTimeout(120);
  await ask(page, 'コインが増える処理はどこ？');
  await page.waitForTimeout(250);
  const header = await page.evaluate(() => {
    const button = document.querySelector('.ai-session-button');
    const chip = document.querySelector('.ai-model-chip');
    const call = window.__hexStub.calls[window.__hexStub.calls.length - 1];
    return {
      title: button.textContent, haspopup: button.getAttribute('aria-haspopup'),
      newChat: !!document.querySelector('.ai-new-chat[aria-label]'),
      model: chip.textContent, modelPopup: chip.getAttribute('aria-haspopup'),
      conversationId: call.conversationId, fields: call.fields,
    };
  });
  check('the header names the chat and offers New chat next to it',
    /コインが増える/.test(header.title) && header.haspopup === 'menu' && header.newChat, JSON.stringify(header.title));
  check('the composer shows which model the next question uses',
    header.model.length > 0 && header.modelPopup === 'menu', header.model);
  check('every turn carries its conversation id and model metadata to the engine',
    !!header.conversationId && ['provider', 'model', 'reasoning'].every((name) => header.fields.includes(name)),
    JSON.stringify({ id: header.conversationId, fields: header.fields }));

  const started = await page.evaluate(async () => {
    document.querySelector('.ai-new-chat').click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const state = window.__hexAi.panel.describeState();
    return { turns: document.querySelectorAll('.ai-turn').length, state, empty: !document.querySelector('.ai-empty').hidden };
  });
  check('New chat empties the transcript without losing the old chat',
    started.turns === 0 && started.empty && started.state.conversations >= 2, JSON.stringify(started.state));

  await stubEngine(page, { answer: '二つ目のチャットの答え' });
  await ask(page, 'セーブしている場所を探して');
  await page.waitForTimeout(250);
  const switched = await page.evaluate(async () => {
    document.querySelector('.ai-session-button').click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const rows = [...document.querySelectorAll('#overlays .menu [role="menuitem"]')].map((n) => n.textContent);
    const back = [...document.querySelectorAll('#overlays .menu [role="menuitem"]')].find((n) => /コインが増える/.test(n.textContent));
    back.click();
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { rows, text: document.querySelector('.ai-conversation').textContent, id: window.__hexAi.panel.describeState().conversationId };
  });
  check('the history menu lists both chats with the current one marked',
    switched.rows.some((t) => /新しいチャット/.test(t)) && switched.rows.filter((t) => /^✓/.test(t)).length === 1, JSON.stringify(switched.rows));
  check('going back to the first chat restores only its own transcript',
    /一つ目のチャットの答え/.test(switched.text) && !/二つ目のチャットの答え/.test(switched.text), switched.text.slice(0, 60));

  /* iPad and phone widths: the header must not need a mouse or a scrollbar. */
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  const narrow = await page.evaluate(() => {
    const head = document.querySelector('.ai-panel-head');
    const sizes = [...head.querySelectorAll('button')].map((n) => Math.round(n.getBoundingClientRect().height));
    return {
      layout: document.getElementById('ai-panel').dataset.layout,
      overflow: head.scrollWidth - head.clientWidth,
      smallest: Math.min(...sizes),
      pageOverflow: document.body.scrollWidth - document.documentElement.clientWidth,
    };
  });
  check('the header still fits on a phone-width panel', narrow.overflow <= 1 && narrow.pageOverflow <= 1, JSON.stringify(narrow));
  check('every header control stays a comfortable tap target', narrow.smallest >= 30, String(narrow.smallest));

  check('no page errors during the whole session', errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
  return state.failures;
});
