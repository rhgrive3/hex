import { loadPlaywright, serve } from '../ai-ui-support.mjs';

const pw = await loadPlaywright();
if (!pw) { console.log('Playwright is not installed; Round 2 single-tab browser test skipped.'); process.exit(0); }
const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/index.html`;
let failures = 0;

for (const name of ['chromium', 'webkit']) {
  const type = pw[name];
  if (!type) continue;
  let browser;
  try { browser = await type.launch({ args: name === 'chromium' ? ['--no-sandbox'] : [] }); }
  catch (error) { console.log(`skip ${name}: ${String(error?.message || error).split('\n')[0]}`); continue; }
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(async () => {
      const { SingleConversationWorkerCoordinator } = await import('/js/userscript/dev/single-tab/single-conversation-worker-coordinator.js');
      const { DEV_WORKER_STATE } = await import('/js/ai/dev/workers/contracts.js');
      class Controller {
        constructor() { this.state = DEV_WORKER_STATE.STARTING; this.page = { id: 'supervisor', url: 'https://chatgpt.com/c/supervisor' }; this.worker = null; this.text = ''; this.listeners = new Set(); this.active = false; this.navigation = []; }
        on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
        emit(kind, data = {}) { for (const fn of this.listeners) fn({ kind, data, observedAt: new Date().toISOString() }); }
        currentConversation() { return this.page ? { ...this.page } : null; }
        workerConversation() { return this.worker ? { ...this.worker } : null; }
        isActive() { return this.active; }
        async navigateToConversation(conversation) { this.navigation.push(conversation.id); this.page = { ...conversation }; return this.page; }
        async createChat() { this.page = null; this.worker = null; return this.observe(); }
        async send(_text, context) { this.active = true; this.state = DEV_WORKER_STATE.WORKING; setTimeout(() => { this.worker = { id: 'worker', url: 'https://chatgpt.com/c/worker' }; this.page = { ...this.worker }; this.text = 'one-line-result'; this.active = false; this.state = DEV_WORKER_STATE.COMPLETED; this.emit('completed', { ...context, responseText: this.text }); }, 20); return { submitted: true }; }
        async followup(text, context) { return this.send(text, context); }
        async nudge(context) { return this.send('nudge', context); }
        async stop() { this.active = false; this.state = DEV_WORKER_STATE.CANCELLED; this.emit('cancelled', {}); return { state: this.state }; }
        observe() { return { state: this.state, chatgptConversationId: this.worker?.id || null, responseText: this.text, observedAt: new Date().toISOString() }; }
        result() { return { status: this.state, chatgptConversationId: this.worker?.id || null, responseText: this.text, observedAt: new Date().toISOString() }; }
      }
      const controller = new Controller();
      const coordinator = new SingleConversationWorkerCoordinator({ controller, tabNodeId: 'one-page' });
      const discovered = await coordinator.discover();
      const claimed = await coordinator.claim({ runId: 'run', workerId: 'worker-1' });
      await coordinator.createChat({ workerId: 'worker-1' });
      const final = await coordinator.send({ workerId: 'worker-1', instruction: 'Return one line.' });
      const pageCount = window.length;
      const visible = controller.currentConversation();
      const navigation = [...controller.navigation];
      await coordinator.release({ workerId: 'worker-1' });
      coordinator.close();
      return { discovered, claimed, final, visible, navigation, pageCount };
    });
    const checks = [
      [context.pages().length === 1, 'exactly one browser page'],
      [result.discovered?.length === 1 && result.discovered[0]?.tabNodeId === 'one-page', 'one logical Worker slot'],
      [result.claimed?.supervisorChatgptConversationId === 'supervisor', 'Supervisor conversation captured'],
      [result.final?.responseText === 'one-line-result' && result.final?.chatgptConversationId === 'worker', 'Worker result captured'],
      [result.visible?.id === 'supervisor', 'Supervisor restored before Worker tool resolves'],
      [result.navigation?.at(-1) === 'supervisor', 'same-tab return navigation'],
    ];
    for (const [ok, label] of checks) { if (!ok) { console.error(`FAIL ${name}: ${label}`); failures++; } else console.log(`ok   ${name}: ${label}`); }
    await context.close();
  } finally { await browser.close(); }
}
server.close();
if (failures) process.exitCode = 1;
