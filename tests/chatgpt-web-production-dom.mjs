/*
 * End-to-end ChatGPT Web capture against a production-shaped DOM, in real
 * browser engines.
 *
 * Existing ChatGPT tests drive hand-built adapter doubles, so they never see
 * layout-dependent text extraction, `:has()` matching, `closest()` over real
 * turn wrappers, SPA history transitions, or structured-clone of the bridge
 * result. This suite runs the real ChatGPTDOMAdapter, ChatGPTTurnController and
 * ChatGPT parent RPC against the DOM shapes captured from an iPad Safari
 * incident, and returns the result through a real MessagePort so the whole
 * request/response path is exercised, not just the DOM read.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { CHATGPT_STUB, COLLAPSIBLE_PROMPT_THRESHOLD, PAGE_HTML } from './fixtures/chatgpt-production-dom.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://chatgpt.com';
const CONVERSATION = '6a7e57ce-765c-83ee-88d3-36012aea892e';
const OTHER_CONVERSATION = '6a4cfd75-fa64-83ee-aa27-d84c7cb2a286';

/* The production prompt is the Hex control protocol envelope: far past the
   length at which ChatGPT switches a user message to the collapsible renderer. */
const LONG_PROMPT = [
  'HEX CONTROL PROTOCOL hex-chatgpt-web-v1',
  '',
  'You are the reasoning/planning component of Hex. Hex tools are the source of facts.',
  'Return exactly ONE JSON object and nothing else. Do not use Markdown or code fences.',
  'Use only the ASCII double quote character U+0022 (") for JSON delimiters.',
  '',
  '<HEX_DATA>',
  JSON.stringify({ protocol: 'hex-chatgpt-web-v1', sessionId: 'ai_test_1', mode: 'chat', style: 'beginner', scope: 'project', messages: [{ role: 'user', content: '解析の始め方を教えて' }], tools: ['search_functions', 'search_strings'] }),
  '</HEX_DATA>',
].join('\n');
const SHORT_PROMPT = '短い質問です';
const DEV_SUPERVISOR_PROMPT = 'HEX DEV SUPERVISOR PROTOCOL hex-dev-supervisor-v1\n<HEX_DEV_DATA>{"history":[]}</HEX_DEV_DATA>';
const ANSWER = '{"type":"final","answer":"まず関数一覧を確認します。","confidence":1.0,"evidenceIds":[],"hypothesisIds":[],"suggestedActions":[],"followups":[]}';

assert.ok(LONG_PROMPT.length >= COLLAPSIBLE_PROMPT_THRESHOLD, 'the long prompt must trigger the collapsible renderer');
assert.ok(SHORT_PROMPT.length < COLLAPSIBLE_PROMPT_THRESHOLD, 'the short prompt must stay uncollapsed');

const bundle = (await build({
  entryPoints: [path.join(ROOT, 'tests/fixtures/chatgpt-bridge-entry.js')],
  bundle: true, format: 'iife', globalName: 'HexBridge', write: false, platform: 'browser',
})).outputFiles[0].text;

const engines = await loadEngines();
for (const [name, browserType] of engines) await run(name, browserType);
console.log(`chatgpt-web-production-dom: ok (${engines.map(([name]) => name).join(', ')})`);

async function run(name, browserType) {
  const browser = await browserType.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] });
  const context = await browser.newContext({ locale: 'ja-JP', viewport: { width: 834, height: 1112 } });
  await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE_HTML }));
  try {
    await scenario(context, name, 'a long collapsible prompt is captured without the localized toggle labels', {
      prompt: LONG_PROMPT,
    }, (result) => {
      assert.equal(result.ok, true, `${name}: ${result.error?.code}/${result.error?.stage}: ${result.error?.message}`);
      assert.equal(result.value.text, ANSWER);
      assert.equal(result.value.conversation.id, CONVERSATION);
      assert.doesNotMatch(JSON.stringify(result.value), /表示を増やす|表示を減らす|あなた:/);
    });

    await scenario(context, name, 'a short prompt is captured', { prompt: SHORT_PROMPT }, (result) => {
      assert.equal(result.ok, true, `${name}: ${result.error?.code}`);
      assert.equal(result.value.text, ANSWER);
    });

    await scenario(context, name, 'New Chat composer rehydration is retried before send', {
      prompt: SHORT_PROMPT, chatgpt: { composerHydrationDelayMs: 120 },
    }, (result) => {
      assert.equal(result.ok, true, `${name}: a provisional iOS composer must not strand Worker submission (${result.error?.code})`);
      assert.equal(result.value.text, ANSWER);
    });

    await scenario(context, name, 'a Dev Supervisor JSON decision survives a stuck generating indicator', {
      prompt: DEV_SUPERVISOR_PROMPT,
      chatgpt: { stuckGeneratingAfterComplete: true, stuckRestartAfterMs: 40 },
    }, (result) => {
      assert.equal(result.ok, true, `${name}: complete Dev JSON must beat a cursor-only stuck Stop indicator (${result.error?.code})`);
      assert.equal(result.value.text, ANSWER, `${name}: cursor residue must be stripped`);
    });

    await scenario(context, name, 'a submitted user turn may hydrate after its wrapper appears', {
      prompt: LONG_PROMPT, chatgpt: { userHydrationDelayMs: 120 },
    }, (result) => {
      assert.equal(result.ok, true, `${name}: a partial first user DOM frame must not become manual-interference (${result.error?.code})`);
      assert.equal(result.value.text, ANSWER);
    });

    await scenario(context, name, 'a long submitted user turn may hydrate beyond the short mismatch window', {
      prompt: LONG_PROMPT, chatgpt: { userHydrationDelayMs: 2200 },
    }, (result) => {
      assert.equal(result.ok, true, `${name}: long collapsible user hydration must not become manual-interference (${result.error?.code})`);
      assert.equal(result.value.text, ANSWER);
    });

    await scenario(context, name, 'owned submission survives indefinitely wrong renderer text', {
      prompt: LONG_PROMPT,
      chatgpt: { userHydrationDelayMs: 60000, userInitialText: '読み込み中…' },
    }, (result) => {
      assert.equal(result.ok, true, `${name}: renderer text must never revoke an owned send (${result.error?.code})`);
      assert.equal(result.value.text, ANSWER);
    });

    await scenario(context, name, 'a historical page alert does not poison a new request', {
      prompt: LONG_PROMPT, chatgpt: { seedPageErrorText: 'Something went wrong in an older operation.' },
    }, (result) => {
      assert.equal(result.ok, true, `${name}: unchanged pre-submit page alerts must be ignored (${result.error?.code})`);
      assert.equal(result.value.text, ANSWER);
    });

    await scenario(context, name, 'a short-lived page-level invalid-input alert is captured', {
      prompt: LONG_PROMPT, chatgpt: { pageErrorText: 'Invalid input.', pageErrorAtMs: 8, pageErrorDurationMs: 25, streamMs: 20 },
    }, (result) => {
      assert.equal(result.ok, false, `${name}: a new invalid-input alert must abort the active Hex turn`);
      assert.equal(result.error.code, 'page-error');
      assert.equal(result.error.stage, 'turn-controller');
    });

    await scenario(context, name, 'a transient route gap is not a conversation switch', {
      prompt: LONG_PROMPT, chatgpt: { transientRouteGapMs: 120, transientRouteAtMs: 20 },
    }, (result) => {
      assert.equal(result.ok, true, `${name}: a temporary "no conversation" reading must not abort the turn (${result.error?.code})`);
      assert.equal(result.value.conversation.id, CONVERSATION);
    });

    await scenario(context, name, 'a new chat may replace its provisional conversation id', {
      prompt: LONG_PROMPT, chatgpt: { migrateToConversation: OTHER_CONVERSATION, migrateAtMs: 40, streamMs: 12 },
    }, (result) => {
      assert.equal(result.ok, true, `${name}: a same-request CID migration must stay attached (${result.error?.code})`);
      assert.equal(result.value.text, ANSWER);
      assert.equal(result.value.conversation.id, OTHER_CONVERSATION);
    });

    await scenario(context, name, 'a stale historical error turn does not poison a healthy request', {
      prompt: LONG_PROMPT,
      seed: [{ kind: 'user', text: '前の質問' }, { kind: 'error', text: 'Something went wrong while generating the response.' }],
    }, (result) => {
      assert.equal(result.ok, true, `${name}: an error from an older turn must not abort a new turn (${result.error?.code})`);
      assert.equal(result.value.text, ANSWER);
    });

    await scenario(context, name, 'streaming node replacement keeps one logical turn', {
      prompt: LONG_PROMPT, chatgpt: { streamMs: 12 },
    }, (result) => {
      assert.equal(result.ok, true, `${name}: DOM re-hydration must not read as a stale response (${result.error?.code})`);
      assert.equal(result.value.text, ANSWER);
    });

    /* Integrity guards that must survive the repair. */
    await scenario(context, name, 'a competing human user turn is still rejected', {
      prompt: LONG_PROMPT, chatgpt: { manualInterference: true },
    }, (result) => {
      assert.equal(result.ok, false, `${name}: manual interference must abort the turn`);
      assert.equal(result.error.code, 'manual-interference');
      assert.equal(result.error.stage, 'turn-controller');
    });

    await scenario(context, name, 'a real existing-conversation switch is still rejected', {
      prompt: LONG_PROMPT,
      seed: [{ kind: 'user', text: '前の既存チャット' }],
      chatgpt: { navigateToConversation: OTHER_CONVERSATION, navigateAtMs: 40, streamMs: 40 },
    }, (result) => {
      assert.equal(result.ok, false, `${name}: a different conversation must abort the turn`);
      assert.equal(result.error.code, 'conversation-switched');
      assert.equal(result.error.stage, 'turn-controller');
    });

    await scenario(context, name, 'opening New Chat during a known conversation is rejected', {
      prompt: LONG_PROMPT,
      seed: [{ kind: 'user', text: '前の既存チャット' }],
      chatgpt: { navigateToNewChat: true, navigateAtMs: 40, navigationDomDelayMs: 300, streamMs: 40 },
    }, (result) => {
      assert.equal(result.ok, false, `${name}: a persistent route loss must abort the turn`);
      assert.equal(result.error.code, 'conversation-switched');
      assert.equal(result.error.stage, 'turn-controller');
    });

    await scenario(context, name, 'an error inside the active response is still reported', {
      prompt: LONG_PROMPT, chatgpt: { failActiveTurn: true },
    }, (result) => {
      assert.equal(result.ok, false, `${name}: an error in the live response must abort the turn`);
      assert.equal(result.error.code, 'response-error');
    });
  } finally {
    await browser.close();
  }
}

async function scenario(context, name, label, options, check) {
  const page = await context.newPage();
  const failures = [];
  page.on('pageerror', (error) => failures.push(String(error?.message || error)));
  try {
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: bundle });
    await page.addScriptTag({ content: CHATGPT_STUB });
    const result = await page.evaluate(async (input) => window.__HEX_RUN__(input), {
      prompt: options.prompt,
      seed: options.seed || null,
      chatgpt: { conversationId: input_conversation(), chunks: chunk(input_answer()), streamMs: 8, ...(options.chatgpt || {}) },
    });
    assert.deepEqual(failures, [], `${name} / ${label}: page errors`);
    check(result);
    console.log(`  ${name}: ${label}`);
  } finally {
    await page.close();
  }
}

function input_conversation() { return CONVERSATION; }
function input_answer() { return ANSWER; }
function chunk(text) {
  const out = [];
  for (let index = 0; index < text.length; index += 24) out.push(text.slice(index, index + 24));
  return out;
}

async function loadEngines() {
  let playwright = null;
  try { playwright = await import('playwright'); } catch { playwright = null; }
  if (!playwright) {
    console.log('chatgpt-web-production-dom: skipped (playwright is not installed)');
    process.exit(0);
  }
  const out = [];
  for (const name of ['chromium', 'webkit']) {
    const type = playwright[name];
    if (!type) continue;
    try { await (await type.launch({ headless: true, args: name === 'chromium' ? ['--no-sandbox'] : [] })).close(); } catch { continue; }
    out.push([name, type]);
  }
  if (!out.length) {
    console.log('chatgpt-web-production-dom: skipped (no browser engine is installed)');
    process.exit(0);
  }
  return out;
}
