import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { ParentPageInspector } from '../../js/userscript/dev/admin/page-inspector.js';
import { createDevWorkerParentRpc, createDevWorkerParentRpcClient } from '../../js/userscript/dev/parent-rpc.js';
import { DevSupervisorV0 } from '../../js/ai/dev/supervisor/dev-supervisor-v0.js';
import { buildDevSupervisorPrompt } from '../../js/ai/dev/protocol/dev-supervisor-prompt.js';

await testBoundedParentInspection();
await testAdminRpcSurface();
await testSupervisorAdminDispatch();
testPostBootstrapDogfoodPrompt();
console.log('post-bootstrap self-improvement kernel: ok');

async function testBoundedParentInspection() {
  const button = fakeNode({ tagName: 'BUTTON', text: 'Create project', attrs: { 'data-testid': 'create-project', 'aria-label': 'Create project' } });
  const link = fakeNode({ tagName: 'A', text: 'My project', attrs: { href: 'https://chatgpt.com/g/g-p-demo/project?secret=do-not-leak' } });
  const editor = fakeNode({ tagName: 'TEXTAREA', text: 'draft must not leak', attrs: { placeholder: 'Message' } });
  const script = {
    src: 'https://chatgpt.com/assets/app.js?cache=123',
    type: 'module', async: false, defer: true, integrity: '', nonce: 'hidden-nonce', textContent: '',
    getAttribute(name) { return this[name] ?? null; },
  };
  const inlineScript = {
    src: '', type: 'application/json', async: false, defer: false, integrity: '', nonce: 'inline-hidden-nonce',
    textContent: Array.from({ length: 8 }, (_value, index) => `self.__next_f.push(["project:createProject:${index}",{"sessionToken":"must-not-leak-${index}","route":"/project"}]);${'x'.repeat(900)}`).join('\n'),
    getAttribute(name) { return this[name] ?? null; },
  };
  const selectorMap = new Map([
    ['button', [button]],
    ['a[href]', [link]],
    ['textarea', [editor]],
  ]);
  const document = {
    title: 'ChatGPT',
    location: { href: 'https://chatgpt.com/g/g-p-demo/project?temporary=secret' },
    scripts: [script, inlineScript],
    querySelectorAll(selector) { return selectorMap.get(selector) || []; },
    querySelector(selector) { return (selectorMap.get(selector) || [])[0] || null; },
  };
  let fetched = null;
  const inspector = new ParentPageInspector({
    document,
    location: document.location,
    fetchRef: async (url, options) => {
      fetched = { url, options };
      return { ok: true, status: 200, text: async () => 'const projectRoute = "/project"; function createProject(){}' };
    },
  });

  const snapshot = inspector.snapshot({ selectors: ['button', 'a[href]', 'textarea'], maxNodes: 10 });
  assert.equal(snapshot.nodeCount, 3);
  assert.equal(snapshot.location.pathname, '/g/g-p-demo/project');
  assert.deepEqual(snapshot.location.searchKeys, ['temporary']);
  assert.equal(snapshot.nodes.find((node) => node.tag === 'textarea').text, null, 'editable text must never cross the sandbox boundary');
  assert.equal(snapshot.nodes.find((node) => node.tag === 'a').href, 'https://chatgpt.com/g/g-p-demo/project', 'href query values must be stripped');
  assert.doesNotMatch(JSON.stringify(snapshot), /do-not-leak|draft must not leak|temporary=secret/);

  const scripts = inspector.scripts();
  assert.equal(scripts.scripts[0].src, 'https://chatgpt.com/assets/app.js');
  assert.equal(scripts.scripts[0].noncePresent, true);
  assert.equal(Object.hasOwn(scripts.scripts[0], 'nonce'), false, 'CSP nonce value must not be exposed');
  const inline = scripts.scripts[1];
  assert.equal(inline.external, false);
  assert.equal(inline.src, null);
  assert.equal(inline.noncePresent, true);
  assert.equal(Object.hasOwn(inline, 'nonce'), false, 'inline CSP nonce value must not be exposed');
  assert.equal(inline.inlineChars, inlineScript.textContent.length);

  /* Regression: page.scripts -> inline index -> page.script_source used to deterministically
     fail with script-not-loaded because scriptSource only accepted node.src. */
  const inlineSource = await inspector.scriptSource({ index: inline.index, needle: 'createProject', contextChars: 4096, maxMatches: 99 });
  assert.equal(fetched, null, 'inline inspection must not perform a network fetch');
  assert.equal(inlineSource.index, inline.index);
  assert.equal(inlineSource.src, null);
  assert.equal(inlineSource.needle, 'createProject');
  assert.ok(inlineSource.excerpts.length > 0 && inlineSource.excerpts.length <= 5, 'inline match count must be bounded');
  assert.ok(inlineSource.excerptChars <= 8 * 1024, 'inline total excerpt output must be bounded');
  assert.match(inlineSource.excerpts[0].text, /createProject/);
  assert.doesNotMatch(JSON.stringify(inlineSource), /must-not-leak/, 'sensitive inline values near a benign match must be redacted');
  await assert.rejects(() => inspector.scriptSource({ index: inline.index }), (error) => error.code === 'inline-needle-required');
  await assert.rejects(() => inspector.scriptSource({ index: inline.index, needle: 'sessionToken' }), (error) => error.code === 'inline-sensitive-needle');
  await assert.rejects(() => inspector.scriptSource({ index: inline.index, needle: 'localStorage' }), (error) => error.code === 'inline-sensitive-needle');

  const source = await inspector.scriptSource({ index: 0, needle: 'createProject', contextChars: 32 });
  assert.equal(source.excerpts.length, 1);
  assert.match(source.excerpts[0].text, /createProject/);
  assert.equal(fetched.options.credentials, 'omit');
  assert.equal(fetched.options.referrerPolicy, 'no-referrer');

  fetched = null;
  const externalSlice = await inspector.scriptSource({ index: 0, offset: 6, maxChars: 256 });
  assert.equal(externalSlice.src, 'https://chatgpt.com/assets/app.js');
  assert.equal(externalSlice.offset, 6);
  assert.match(externalSlice.text, /projectRoute/);
  assert.equal(fetched.options.credentials, 'omit', 'external no-needle reads must retain credential omission');
  assert.equal(fetched.options.referrerPolicy, 'no-referrer', 'external no-needle reads must retain no-referrer');
  await assert.rejects(() => inspector.scriptSource({ src: 'https://evil.example/x.js' }), (error) => error.code === 'script-not-loaded' && error.message === 'Requested script is not a currently loaded external page script.');
}

async function testAdminRpcSurface() {
  const { port1, port2 } = new MessageChannel();
  const runtime = {
    pageSnapshot: async (args) => ({ kind: 'snapshot', args }),
    pageScripts: async () => ({ kind: 'scripts' }),
    pageScriptSource: async (args) => ({ kind: 'source', args }),
  };
  const server = createDevWorkerParentRpc({ port: port1, runtime });
  const client = createDevWorkerParentRpcClient({ port: port2 });
  assert.equal((await client.pageSnapshot({ selectors: ['aside'] })).kind, 'snapshot');
  assert.equal((await client.pageScripts()).kind, 'scripts');
  assert.equal((await client.pageScriptSource({ index: 0 })).kind, 'source');
  client.close();
  server.close();
}

async function testSupervisorAdminDispatch() {
  let sequence = 0;
  const workerClient = {
    enabled: true,
    pageSnapshot: async (args) => ({ kind: 'snapshot', args }),
    pageScripts: async () => ({ kind: 'scripts' }),
    pageScriptSource: async (args) => ({ kind: 'source', args }),
  };
  const supervisor = new DevSupervisorV0({
    workerClient,
    idFactory: (kind) => `${kind}-admin-${++sequence}`,
    now: () => '2026-08-18T00:00:00.000Z',
  });
  assert.ok(supervisor.availableTools.includes('chatgpt.page.snapshot'));
  let run = supervisor.activate(supervisor.createRun({ goal: 'inspect current ChatGPT Projects UI' }));
  const executed = await supervisor.executeToolDecision(run, {
    type: 'tool',
    tool: 'chatgpt.page.snapshot',
    arguments: { selectors: ['aside'] },
    purpose: 'inspect current DOM',
  });
  assert.equal(executed.result.kind, 'snapshot');
  assert.equal(executed.run.workerId, null, 'admin observation must not fabricate or consume a Worker identity');
}

function testPostBootstrapDogfoodPrompt() {
  const supervisor = new DevSupervisorV0({
    workerClient: {
      enabled: true,
      pageSnapshot: async () => ({}),
      pageScripts: async () => ({}),
      pageScriptSource: async () => ({}),
    },
    idFactory: (kind) => `${kind}-prompt`,
    now: () => '2026-08-18T00:00:00.000Z',
  });
  const run = supervisor.activate(supervisor.createRun({ goal: 'Project automationまで自己改善し続ける' }));
  const prompt = buildDevSupervisorPrompt({ run, availableTools: supervisor.availableTools });
  assert.match(prompt, /versioned DOM Skill system -> max-6 multi-Worker Tab Pool -> dynamic task graph -> ChatGPT Project automation/);
  assert.match(prompt, /chatgpt\.page\.snapshot/);
  assert.doesNotMatch(prompt, /Never request, create, or depend on another browser tab or window/);
}

function fakeNode({ tagName, text = '', attrs = {} }) {
  return {
    tagName,
    nodeName: tagName,
    textContent: text,
    classList: [],
    disabled: false,
    hidden: false,
    isContentEditable: false,
    href: attrs.href || null,
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
  };
}
