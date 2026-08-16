import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  captureRuntimeHostLocation,
  runtimeLocationFromSnapshot,
} from '../js/userscript/runtime-host-location.js';

const worker = 'https://ida.rhgrive.workers.dev';
const chatgpt = captureRuntimeHostLocation({
  origin: 'https://chatgpt.com',
  pathname: '/c/test',
  search: '?model=gpt-5',
  href: 'https://chatgpt.com/c/test?model=gpt-5',
});
assert.equal(Object.isFrozen(chatgpt), true);
assert.deepEqual(chatgpt, {
  origin: 'https://chatgpt.com',
  pathname: '/c/test',
  search: '?model=gpt-5',
  href: 'https://chatgpt.com/c/test?model=gpt-5',
});

const opaqueBlobLocation = {
  origin: 'null',
  pathname: '/runtime.js',
  search: '',
  href: 'blob:https://chatgpt.com/runtime',
};
assert.deepEqual(runtimeLocationFromSnapshot(chatgpt, opaqueBlobLocation), chatgpt,
  'protected runtime must keep the page location captured before Blob import');

const embed = captureRuntimeHostLocation({
  origin: worker,
  pathname: '/embed/chatgpt',
  search: '?__hex_embed_generation=42&__hex_ai_provider=chatgpt',
  href: `${worker}/embed/chatgpt?__hex_embed_generation=42&__hex_ai_provider=chatgpt`,
});
const restoredEmbed = runtimeLocationFromSnapshot(embed, opaqueBlobLocation);
assert.deepEqual(restoredEmbed, embed,
  'iframe route and generation must survive a Blob/isolated-world location change');
assert.match(restoredEmbed.search, /__hex_embed_generation=42/,
  'captured iframe generation must remain available to the attach handshake');

assert.deepEqual(runtimeLocationFromSnapshot({ origin: 'null' }, {
  origin: worker,
  pathname: '/',
  search: '',
  href: `${worker}/`,
}), {
  origin: worker,
  pathname: '/',
  search: '',
  href: `${worker}/`,
}, 'invalid snapshots must fall back to the live document location');

const loaderSource = await readFile(new URL('../js/userscript/loader.js', import.meta.url), 'utf8');
const protectedEntrySource = await readFile(new URL('../js/userscript/protected-entry.js', import.meta.url), 'utf8');
assert.match(loaderSource, /captureRuntimeHostLocation\(\)/);
assert.match(loaderSource, /__HEX_RUNTIME_HOST_LOCATION__\s*=\s*RUNTIME_HOST_LOCATION/);
assert.ok(loaderSource.indexOf('__HEX_RUNTIME_HOST_LOCATION__ = RUNTIME_HOST_LOCATION') < loaderSource.indexOf('import(blobUrl)'),
  'host location snapshot must be published before protected runtime import');
assert.match(protectedEntrySource, /runtimeLocationFromSnapshot\(globalThis\.__HEX_RUNTIME_HOST_LOCATION__/);
assert.match(protectedEntrySource, /startEmbedChildRuntime\(\{\s*cssText:\s*PROTECTED_HOST\.css,\s*location:\s*runtimeLocation\s*\}\)/);
assert.doesNotMatch(protectedEntrySource, /location\.origin\s*!==\s*apiOrigin/,
  'origin gate must use the captured host location rather than Blob-world location');

console.log('userscript runtime host location: ok');
