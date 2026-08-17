import fs from 'node:fs';

const path = 'js/ai/dev/supervisor/dev-supervisor-engine-v0.js';
let text = fs.readFileSync(path, 'utf8');
const guard = `  async run(input = {}) {
    if (!this.bridge || typeof this.bridge.request !== 'function') throw new Error('ChatGPT Web bridge is required for Dev Supervisor.');
    const ids = {
`;
if (!text.includes(guard)) throw new Error('Dev Supervisor bridge guard anchor missing');
text = text.replace(guard, `  async run(input = {}) {
    const ids = {
`, 1);
const anchor = `    this.settings.setLastRun(run);
    input.onActivity?.({ label: 'Dev Supervisor', detail: run.status });
    const history = [];
`;
if (!text.includes(anchor)) throw new Error('Dev Supervisor foundation insertion anchor missing');
text = text.replace(anchor, `    this.settings.setLastRun(run);
    input.onActivity?.({ label: 'Dev Supervisor', detail: run.status });
    if (!this.bridge || typeof this.bridge.request !== 'function') {
      return uiResponse(\`Dev Supervisor run \${run.runId} created.\`, run, []);
    }
    const history = [];
`, 1);
fs.writeFileSync(path, text);
console.log('Round 1 foundation compatibility staged.');
