import { loadPlaywright, serve } from '../ai-ui-support.mjs';

const pw = await loadPlaywright();
if (!pw) {
  console.log('Playwright is not installed; Round 2 cross-tab browser test skipped.');
  process.exit(0);
}

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/index.html`;
let failures = 0;

for (const name of ['chromium', 'webkit']) {
  const type = pw[name];
  if (!type) continue;
  let browser;
  try {
    browser = await type.launch({ args: name === 'chromium' ? ['--no-sandbox'] : [] });
  } catch (error) {
    console.log(`skip ${name}: ${String(error?.message || error).split('\n')[0]}`);
    continue;
  }

  try {
    const context = await browser.newContext();
    const supervisor = await context.newPage();
    const worker = await context.newPage();
    await Promise.all([
      supervisor.goto(base, { waitUntil: 'domcontentloaded' }),
      worker.goto(base, { waitUntil: 'domcontentloaded' }),
    ]);

    await worker.evaluate(async () => {
      const { createBrowserTabTransport } = await import('/js/userscript/dev/tab-mesh/transport.js');
      const { createTabNode, TAB_NODE_ROLE } = await import('/js/userscript/dev/tab-mesh/tab-node.js');
      const { WorkerTabHost } = await import('/js/userscript/dev/worker-host/worker-host.js');
      const { DEV_WORKER_STATE, DEV_WORKER_NUDGE } = await import('/js/ai/dev/workers/contracts.js');
      const secret = new Uint8Array(32);
      secret.fill(23);
      const transport = await createBrowserTabTransport({ nodeId: 'browser-worker', secret });

      class BrowserWorkerController {
        constructor() {
          this.state = DEV_WORKER_STATE.STARTING;
          this.conversation = null;
          this.text = '';
          this.listeners = new Set();
          this.lastMessage = null;
        }
        on(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
        emit(kind, data = {}) {
          for (const listener of this.listeners) listener({ kind, data, observedAt: new Date().toISOString() });
        }
        async createChat() {
          this.state = DEV_WORKER_STATE.STARTING;
          this.conversation = null;
          this.text = '';
          return this.observe();
        }
        async send(text, context) {
          this.lastMessage = text;
          this.state = DEV_WORKER_STATE.WORKING;
          this.emit('started', context);
          setTimeout(() => {
            this.conversation = { id: 'browser-cid-1' };
            this.text = 'one-line-result';
            this.state = DEV_WORKER_STATE.COMPLETED;
            this.emit('progress', { ...context, generating: false, responseText: this.text });
            this.emit('completed', { ...context, responseText: this.text });
          }, 20);
          return { submitted: true, status: this.state, chatgptConversationId: this.conversation?.id || null };
        }
        async followup(text, context) { return this.send(text, context); }
        async nudge(context) { return this.followup(DEV_WORKER_NUDGE, context); }
        async stop() {
          this.state = DEV_WORKER_STATE.CANCELLED;
          this.emit('cancelled', { reason: 'stop-requested' });
          return {
            outcome: 'cancel-requested', ownershipVerified: true, controlInvoked: true,
            controllerAborted: true, state: this.state, generatingObservedAfter: false,
          };
        }
        observe() {
          return {
            state: this.state,
            chatgptConversationId: this.conversation?.id || null,
            responseText: this.text,
            observedAt: new Date().toISOString(),
            generating: this.state === DEV_WORKER_STATE.WORKING,
            visibility: 'foreground',
            observability: 'live',
          };
        }
        result() {
          return {
            status: this.state,
            responseText: this.text,
            chatgptConversationId: this.conversation?.id || null,
            observedAt: new Date().toISOString(),
          };
        }
      }

      const controller = new BrowserWorkerController();
      const tabNode = createTabNode({ role: TAB_NODE_ROLE.AVAILABLE, idFactory: () => 'browser-worker' });
      const host = new WorkerTabHost({ transport, tabNode, controller });
      await host.register();
      window.__r2 = { transport, host, controller };
    });

    const result = await supervisor.evaluate(async () => {
      const { createBrowserTabTransport } = await import('/js/userscript/dev/tab-mesh/transport.js');
      const { SingleWorkerCoordinator } = await import('/js/userscript/dev/tab-mesh/single-worker-coordinator.js');
      const secret = new Uint8Array(32);
      secret.fill(23);
      const transport = await createBrowserTabTransport({ nodeId: 'browser-supervisor', secret });
      const coordinator = new SingleWorkerCoordinator({ transport });
      window.__r2 = { transport, coordinator };

      const discovered = await coordinator.discover();
      const claimed = await coordinator.claim({ runId: 'browser-run', workerId: 'browser-worker-1' });
      let secondClaimCode = null;
      try {
        await coordinator.claim({ runId: 'other-run', workerId: 'other-worker' });
      } catch (error) {
        secondClaimCode = error?.code || null;
      }
      const created = await coordinator.createChat({ workerId: 'browser-worker-1' });
      const submitted = await coordinator.send({ workerId: 'browser-worker-1', instruction: 'Return one line.' });
      const completed = await coordinator.waitEvent({ events: ['worker.completed'], runId: 'browser-run' });
      const final = await coordinator.result({ workerId: 'browser-worker-1' });
      const released = await coordinator.release({ workerId: 'browser-worker-1' });
      return { discovered, claimed, secondClaimCode, created, submitted, completed, final, released };
    });

    const checks = [
      [result.discovered?.length === 1 && result.discovered[0]?.tabNodeId === 'browser-worker', 'Worker registration/discovery'],
      [result.claimed?.workerId === 'browser-worker-1', 'single Worker claim'],
      [result.secondClaimCode === 'worker-busy', 'second claim rejected'],
      [result.created?.tabNodeId === 'browser-worker', 'Worker Chat create command routing'],
      [result.submitted?.submitted === true, 'Worker send command routing'],
      [result.completed?.type === 'worker.completed', 'Worker completion event'],
      [result.final?.responseText === 'one-line-result' && result.final?.chatgptConversationId === 'browser-cid-1', 'Worker result capture'],
      [result.released?.role === 'available' && result.released?.claimed === false, 'Worker release/reuse state'],
    ];
    for (const [ok, label] of checks) {
      if (!ok) {
        console.error(`FAIL ${name}: ${label}`);
        failures += 1;
      } else {
        console.log(`ok   ${name}: ${label}`);
      }
    }

    const workerLastMessage = await worker.evaluate(() => window.__r2.controller.lastMessage);
    if (workerLastMessage !== 'Return one line.') {
      console.error(`FAIL ${name}: command executed in Worker tab only`);
      failures += 1;
    } else {
      console.log(`ok   ${name}: command executed in Worker tab only`);
    }

    await Promise.all([
      supervisor.evaluate(() => { window.__r2.coordinator.close(); window.__r2.transport.close(); }),
      worker.evaluate(() => { window.__r2.host.close(); window.__r2.transport.close(); }),
    ]);
    await context.close();
  } finally {
    await browser.close();
  }
}

server.close();
if (failures) process.exitCode = 1;
