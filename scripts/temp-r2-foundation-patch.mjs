import fs from 'node:fs';

const enginePath = 'js/ai/dev/supervisor/dev-supervisor-engine-v0.js';
let engine = fs.readFileSync(enginePath, 'utf8');
const guard = `  async run(input = {}) {
    if (!this.bridge || typeof this.bridge.request !== 'function') throw new Error('ChatGPT Web bridge is required for Dev Supervisor.');
    const ids = {
`;
if (!engine.includes(guard)) throw new Error('Dev Supervisor bridge guard anchor missing');
engine = engine.replace(guard, `  async run(input = {}) {
    const ids = {
`, 1);
const anchor = `    this.settings.setLastRun(run);
    input.onActivity?.({ label: 'Dev Supervisor', detail: run.status });
    const history = [];
`;
if (!engine.includes(anchor)) throw new Error('Dev Supervisor foundation insertion anchor missing');
engine = engine.replace(anchor, `    this.settings.setLastRun(run);
    input.onActivity?.({ label: 'Dev Supervisor', detail: run.status });
    if (!this.bridge || typeof this.bridge.request !== 'function') {
      return uiResponse(\`Dev Supervisor run \${run.runId} created.\`, run, []);
    }
    const history = [];
`, 1);
fs.writeFileSync(enginePath, engine);

const coordinatorPath = 'js/userscript/dev/single-tab/single-conversation-worker-coordinator.js';
let coordinator = fs.readFileSync(coordinatorPath, 'utf8');
if (!coordinator.includes('this.claim = null;') || !coordinator.includes('async claim({ runId, workerId } = {})')) {
  throw new Error('Single-tab Worker claim-state anchors missing');
}
coordinator = coordinator.replaceAll('this.claim', 'this.claimed');
fs.writeFileSync(coordinatorPath, coordinator);

const adapterPath = 'js/userscript/chatgpt-adapter.js';
let adapter = fs.readFileSync(adapterPath, 'utf8');
const freshAnchor = `    const priorTurns = conversationTurnIds(this.adapter);
    if (!current) {
      const alreadyFresh = await waitFor(() => {
        if (this.adapter.conversation()) return null;
        const composer = this.adapter.composer();
`;
if (!adapter.includes(freshAnchor)) throw new Error('Fresh-surface adapter anchor missing');
adapter = adapter.replace(freshAnchor, `    const priorTurns = conversationTurnIds(this.adapter);
    if (!current && typeof this.adapter.composer === 'function') {
      const alreadyFresh = await waitFor(() => {
        if (this.adapter.conversation()) return null;
        const composer = this.adapter.composer();
`, 1);
fs.writeFileSync(adapterPath, adapter);

const routingTestPath = 'tests/chatgpt-web-runtime.mjs';
let routingTest = fs.readFileSync(routingTestPath, 'utf8');
const firstExpectation = `  await router.route('A'); assert.equal(fresh, 1);
`;
if (!routingTest.includes(firstExpectation)) throw new Error('Clean-surface routing expectation anchor missing');
routingTest = routingTest.replace(firstExpectation,
`  await router.route('A');
  assert.equal(fresh, 0, 'an already-clean ChatGPT surface must be adopted without a redundant New Chat click');
`, 1);
const secondExpectation = `  await router.route('B'); assert.equal(fresh, 2);
`;
if (!routingTest.includes(secondExpectation)) throw new Error('Existing-conversation routing expectation anchor missing');
routingTest = routingTest.replace(secondExpectation,
`  await router.route('B');
  assert.equal(fresh, 1, 'routing away from an existing conversation must still explicitly create a fresh ChatGPT conversation');
`, 1);
fs.writeFileSync(routingTestPath, routingTest);

console.log('Round 1 compatibility, Worker claim-state, fresh-surface routing, and adapter contract staged.');
