import assert from 'node:assert/strict';
import { DomSkillRegistry } from '../../js/userscript/dev/skills/dom-skill-registry.js';
import { executeAutomationProgram, validateAutomationProgram } from '../../js/userscript/dev/skills/automation-program.js';

await testAutomationProgramReadAndMutation();
await testSkillLifecycleRollback();
testValidationFailClosed();
console.log('DOM Skill system: ok');

async function testAutomationProgramReadAndMutation() {
  const button = fakeNode({ tagName: 'BUTTON', text: 'Create project', attrs: { 'data-testid': 'create-project' } });
  const input = fakeNode({ tagName: 'INPUT', attrs: { placeholder: 'Project name' } });
  const document = fakeDocument({
    '[data-testid="create-project"]': [button],
    'input[placeholder="Project name"]': [input],
  });
  const read = await executeAutomationProgram({
    version: 1, name: 'probe', readOnly: true,
    steps: [
      { op: 'query', selector: '[data-testid="create-project"]', as: 'button' },
      { op: 'assert', condition: { type: 'exists', target: 'button' } },
      { op: 'readText', target: 'button', as: 'label' },
      { op: 'return', value: { label: { var: 'label' } } },
    ],
  }, { document, location: fakeLocation() });
  assert.deepEqual(read, { label: 'Create project' });

  const mutated = await executeAutomationProgram({
    version: 1, name: 'create', readOnly: false,
    steps: [
      { op: 'query', selector: 'input[placeholder="Project name"]', as: 'name' },
      { op: 'setValue', target: 'name', value: 'Hex Project' },
      { op: 'dispatchEvent', target: 'name', type: 'input' },
      { op: 'query', selector: '[data-testid="create-project"]', as: 'button' },
      { op: 'click', target: 'button' },
      { op: 'return', value: { value: { var: 'name' } } },
    ],
  }, { document, location: fakeLocation() });
  assert.equal(input.value, 'Hex Project');
  assert.equal(input.events[0]?.type, 'input');
  assert.equal(button.clicks, 1);
  assert.equal(mutated.value.node, 'input', 'DOM references must be returned only as bounded descriptors');
}

async function testSkillLifecycleRollback() {
  const button = fakeNode({ tagName: 'BUTTON', text: 'Create project v1', attrs: { 'data-testid': 'create-project' } });
  const document = fakeDocument({ '[data-testid="create-project"]': [button] });
  const registry = new DomSkillRegistry({ document, location: fakeLocation(), now: monotonicNow() });

  const v1 = skillManifest('1', 'Create project v1');
  let state = registry.installCandidate(v1);
  assert.equal(state.candidateVersion, '1');
  let validation = await registry.validateCandidate({ skillId: 'chatgpt.projects' });
  assert.equal(validation.validation.ok, true);
  state = registry.activate({ skillId: 'chatgpt.projects' });
  assert.equal(state.activeVersion, '1');
  const v1Result = await registry.run({ skillId: 'chatgpt.projects', program: 'probe' });
  assert.equal(v1Result.result.label, 'Create project v1');

  button.textContent = 'Create project v2';
  registry.installCandidate(skillManifest('2', 'Create project v2'));
  await registry.validateCandidate({ skillId: 'chatgpt.projects' });
  state = registry.activate({ skillId: 'chatgpt.projects' });
  assert.equal(state.activeVersion, '2');
  assert.equal(state.previousVersion, '1');
  state = registry.rollback({ skillId: 'chatgpt.projects' });
  assert.equal(state.activeVersion, '1');
  assert.equal(state.previousVersion, '2');

  const action = await registry.run({ skillId: 'chatgpt.projects', program: 'open' });
  assert.equal(action.version, '1');
  assert.equal(button.clicks, 1);
}

function testValidationFailClosed() {
  assert.throws(() => validateAutomationProgram({
    version: 1, name: 'bad-probe', readOnly: true,
    steps: [{ op: 'click', target: 'button' }],
  }, { requireReadOnly: true }), (error) => error.code === 'program-not-read-only');

  assert.throws(() => validateAutomationProgram({
    version: 1, name: 'eval', readOnly: false,
    steps: [{ op: 'eval', code: 'window.location' }],
  }), (error) => error.code === 'op-unsupported');

  const tooMany = Array.from({ length: 129 }, () => ({ op: 'return', value: null }));
  assert.throws(() => validateAutomationProgram({ version: 1, name: 'large', readOnly: true, steps: tooMany }), (error) => error.code === 'program-too-large');

  const registry = new DomSkillRegistry({ document: fakeDocument({}), location: fakeLocation() });
  assert.throws(() => registry.installCandidate({
    schema: 'hex-dom-skill-v1', skillId: 'chatgpt.projects', version: 'bad',
    validationPrograms: ['mutate'],
    programs: { mutate: { version: 1, name: 'mutate', readOnly: false, steps: [{ op: 'navigate', url: 'https://chatgpt.com/' }] } },
  }), (error) => error.code === 'program-not-read-only');
}

function skillManifest(version, expectedLabel) {
  return {
    schema: 'hex-dom-skill-v1',
    skillId: 'chatgpt.projects',
    version,
    description: 'Test Project DOM Skill',
    validationPrograms: ['probe'],
    programs: {
      probe: {
        version: 1, name: 'probe', readOnly: true,
        steps: [
          { op: 'query', selectors: ['[data-testid="create-project"]', 'button[aria-label="Create project"]'], as: 'button' },
          { op: 'assert', condition: { type: 'exists', target: 'button' } },
          { op: 'readText', target: 'button', as: 'label' },
          { op: 'assert', condition: { type: 'equals', left: { var: 'label' }, right: expectedLabel } },
          { op: 'return', value: { label: { var: 'label' } } },
        ],
      },
      open: {
        version: 1, name: 'open', readOnly: false,
        steps: [
          { op: 'query', selector: '[data-testid="create-project"]', as: 'button' },
          { op: 'click', target: 'button' },
          { op: 'return', value: { clicked: true } },
        ],
      },
    },
  };
}

function fakeDocument(selectorMap) {
  return {
    querySelector(selector) { return (selectorMap[selector] || [])[0] || null; },
    querySelectorAll(selector) { return selectorMap[selector] || []; },
  };
}
function fakeLocation() {
  return { href: 'https://chatgpt.com/', hostname: 'chatgpt.com', assign(url) { this.href = url; } };
}
function fakeNode({ tagName, text = '', attrs = {} }) {
  return {
    tagName, nodeName: tagName, textContent: text, value: '', disabled: false, hidden: false,
    isContentEditable: false, clicks: 0, events: [],
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; },
    click() { this.clicks += 1; }, focus() {}, dispatchEvent(event) { this.events.push(event); return true; },
  };
}
function monotonicNow() {
  let n = 0;
  return () => `2026-08-18T00:00:${String(n++).padStart(2, '0')}.000Z`;
}
