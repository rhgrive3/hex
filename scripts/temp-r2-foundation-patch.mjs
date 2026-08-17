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

console.log('Round 1 foundation compatibility and Worker claim-state repair staged.');
