import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { toExactArrayBuffer } from '../js/userscript/array-buffer.js';
import {
  publicRuntimeManifest, signRuntimeSession, validateRuntimeBootstrap, verifyRuntimeSession,
} from '../js/userscript/runtime-security.js';

const root = new URL('../', import.meta.url);
const [wranglerText, workerEntry, entry, bridge, adapter, selectors, buildScript, loaderSource, template, secretsModule, embedded] = await Promise.all([
  readFile(new URL('wrangler.jsonc', root), 'utf8'), readFile(new URL('worker-entry.js', root), 'utf8'),
  readFile(new URL('js/userscript/entry.js', root), 'utf8'), readFile(new URL('js/userscript/chatgpt-bridge.js', root), 'utf8'),
  readFile(new URL('js/userscript/chatgpt-adapter.js', root), 'utf8'), readFile(new URL('js/userscript/chatgpt-selectors.js', root), 'utf8'),
  readFile(new URL('scripts/build-userscript.mjs', root), 'utf8'), readFile(new URL('js/userscript/loader.js', root), 'utf8'),
  readFile(new URL('userscript/hex.user.template.js', root), 'utf8'), import('../.runtime-build/runtime-secrets.js'), import('../.runtime-build/embedded-assets.js'),
]);

const wrangler = JSON.parse(wranglerText.replace(/^\s*\/\/.*$/gm, ''));
assert.equal(wrangler.name, 'ida');
assert.equal(wrangler.assets.directory, './dist');
assert.equal(wrangler.assets.run_worker_first, true);
assert.ok(wrangler.durable_objects.bindings.some((item) => item.name === 'RUNTIME_BOOTSTRAP'));

assert.match(workerEntry, /POST|request\.method !== 'POST'/);
assert.match(workerEntry, /RuntimeBootstrap/);
assert.match(workerEntry, /replayed-nonce/);
assert.match(workerEntry, /replayed-session/);
assert.match(workerEntry, /ECDH/);
assert.match(workerEntry, /HKDF/);
assert.match(workerEntry, /AES-GCM/);
assert.match(workerEntry, /invalid-or-expired-session/);
assert.match(workerEntry, /isPrivatePath/);
assert.doesNotMatch(workerEntry, /USER_SCRIPT_ASSET_PREFIX|serveUserscriptAsset/);

assert.match(entry, /installChatGPTWebBridge/);
assert.match(entry, /installUserscriptNetworkBridge/);
assert.doesNotMatch(entry, /prepareUserscriptWorkers|installProviderControl|Gemini 3\.7 Flash/);
assert.match(bridge, /ChatGPTDOMAdapter/);
assert.match(adapter, /baselineAssistant/);
assert.match(adapter, /manual-interference/);
assert.match(adapter, /quietMs/);
assert.match(adapter, /model-mismatch/);
assert.match(adapter, /conversation-switched/);
assert.match(selectors, /composer/);
assert.doesNotMatch(bridge + adapter, /document\.cookie|backend-api|sentinel|turnstile/i);

assert.match(buildScript, /minifyIdentifiers:\s*true/);
assert.match(buildScript, /sourcemap:\s*false/);
assert.match(buildScript, /createCipheriv\('aes-256-gcm'/);
assert.match(buildScript, /gzipSync/);
assert.match(buildScript, /MAX_LOADER_BYTES/);
assert.match(buildScript, /bundleCss/);
assert.match(loaderSource, /async function fetchBytes/);
assert.match(loaderSource, /credentials:\s*'omit'/);
assert.match(loaderSource, /toExactArrayBuffer/);
assert.match(loaderSource, /SHA-256 integrity digest/);
assert.doesNotMatch(loaderSource, /responseType:\s*'arraybuffer'/);
assert.doesNotMatch(loaderSource, /subtle\.digest\('SHA-256',\s*bytes\)/);
assert.doesNotMatch(embedded.PROTECTED_HOST.css, /@import\b/);
assert.match(embedded.PROTECTED_HOST.scopedCss, /@scope \(#hex-userscript-host\)/);
assert.doesNotMatch(embedded.PROTECTED_HOST.scopedCss, /(?:^|[},])\s*(?:html|body)(?=[\s.#:[,{>+~])/);

const backing = new Uint8Array([9, 1, 2, 3, 8]);
const exact = toExactArrayBuffer(backing.subarray(1, 4));
assert.ok(exact instanceof ArrayBuffer);
assert.notEqual(exact, backing.buffer);
assert.deepEqual([...new Uint8Array(exact)], [1, 2, 3]);
assert.equal(toExactArrayBuffer(exact), exact);

assert.match(template, /^\/\/ ==UserScript==/);
assert.match(template, /@match\s+https:\/\/chatgpt\.com\/\*/);
assert.match(template, /@grant\s+GM\.xmlHttpRequest/);
assert.match(template, /__HEX_ORIGIN__\/hex\.meta\.js/);
assert.doesNotMatch(template, /responseType:"arraybuffer"/);
assert.ok(Buffer.byteLength(template) < 64 * 1024, `loader is ${Buffer.byteLength(template)} bytes`);
for (const forbidden of ['Semantic IR', 'createHexToolRegistry', 'decompileFunction', 'EvidenceStore', 'platform-worker.bundle', '__HEX_WORKER_MANIFEST__']) assert.doesNotMatch(template, new RegExp(forbidden));

const distFiles = await walk(new URL('dist/', root));
for (const forbidden of ['js/app.js', 'js/decompile.js', 'js/ir.js', 'css/app.css', 'package.json', 'worker-entry.js', 'wrangler.jsonc']) {
  assert.ok(!distFiles.some((path) => path === forbidden), `raw path leaked into dist: ${forbidden}`);
}

const build = secretsModule.RUNTIME_BUILD;
const ciphertext = new Uint8Array(await readFile(new URL(`dist${build.manifest.assetPath}`, root)));
assert.equal(await sha256(ciphertext), build.manifest.ciphertextHash);
const key = await webcrypto.subtle.importKey('raw', fromB64(build.contentKey), 'AES-GCM', false, ['decrypt']);
const params = { name: 'AES-GCM', iv: fromB64(build.manifest.iv), additionalData: new TextEncoder().encode(build.manifest.aad), tagLength: 128 };
const compressedRuntime = await webcrypto.subtle.decrypt(params, key, ciphertext);
const runtimeSource = gunzipSync(new Uint8Array(compressedRuntime)).toString('utf8');
assert.match(runtimeSource, /https:\/\/hex\.invalid\/js\/backend\.js/);
assert.doesNotMatch(runtimeSource, /userscript-assets|sourceMappingURL/);
const tampered = ciphertext.slice(); tampered[0] ^= 1;
await assert.rejects(webcrypto.subtle.decrypt(params, key, tampered));
const wrongKey = await webcrypto.subtle.importKey('raw', new Uint8Array(32).fill(7), 'AES-GCM', false, ['decrypt']);
await assert.rejects(webcrypto.subtle.decrypt(params, wrongKey, ciphertext));
const wrongIv = { ...params, iv: fromB64(build.manifest.iv).map((value, index) => index ? value : value ^ 1) };
await assert.rejects(webcrypto.subtle.decrypt(wrongIv, key, ciphertext));

const bootstrapInput = {
  nonce: 'nonce_0123456789abcdef', requestId: 'request_0123456789', sessionIdentity: 'session_0123456789',
  loaderVersion: '2.0.123', buildId: build.manifest.buildId,
  clientPublicKey: { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) },
};
assert.equal(validateRuntimeBootstrap(bootstrapInput, { buildId: build.manifest.buildId }), null);
assert.equal(validateRuntimeBootstrap({ ...bootstrapInput, buildId: 'wrong-build' }, { buildId: build.manifest.buildId }), 'wrong-build');
const signingKey = fromB64(build.signingKey), now = Date.now();
const sessionToken = await signRuntimeSession({ v: 1, sid: 'session-valid', bid: build.manifest.buildId, rid: 'request-valid', exp: Math.floor(now / 1000) + 60 }, signingKey);
assert.equal((await verifyRuntimeSession(sessionToken, signingKey, { now })).sid, 'session-valid');
const [payloadPart, signaturePart] = sessionToken.split('.');
const tamperedSignature = `${signaturePart[0] === 'A' ? 'B' : 'A'}${signaturePart.slice(1)}`;
assert.equal(await verifyRuntimeSession(`${payloadPart}.${tamperedSignature}`, signingKey, { now }), null);
const expired = await signRuntimeSession({ v: 1, sid: 'session-expired', bid: build.manifest.buildId, rid: 'request-expired', exp: Math.floor(now / 1000) - 1 }, signingKey);
assert.equal(await verifyRuntimeSession(expired, signingKey, { now }), null);
assert.equal(publicRuntimeManifest(build.manifest).assetPath, undefined);

console.log('userscript-host secure distribution: ok');

async function walk(url, prefix = '') { const out = []; for (const name of await readdir(url)) { const child = new URL(name + '/', url); const info = await stat(new URL(name, url)); if (info.isDirectory()) out.push(...await walk(child, `${prefix}${name}/`)); else out.push(`${prefix}${name}`); } return out; }
async function sha256(value) { const digest = await webcrypto.subtle.digest('SHA-256', value); return Buffer.from(digest).toString('hex'); }
function fromB64(value) { return Buffer.from(value, 'base64url'); }
