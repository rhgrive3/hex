import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  captureRuntimeHostLocation,
  runtimeHostSnapshotFromGlobals,
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

const embedHref = `${worker}/embed/chatgpt?__hex_embed_generation=42&__hex_ai_provider=chatgpt`;
const hrefOnlyEmbed = captureRuntimeHostLocation({
  origin: 'null',
  pathname: '/wrong-path',
  search: '?wrong=1',
  href: embedHref,
});
assert.deepEqual(hrefOnlyEmbed, {
  origin: worker,
  pathname: '/embed/chatgpt',
  search: '?__hex_embed_generation=42&__hex_ai_provider=chatgpt',
  href: embedHref,
}, 'a valid absolute href must be the authoritative source when WebKit exposes an opaque origin');

const documentRecoveredEmbed = captureRuntimeHostLocation({
  get origin() { throw new Error('isolated-world origin getter'); },
  get href() { throw new Error('isolated-world href getter'); },
  pathname: '/wrong',
  search: '',
}, {
  URL: embedHref,
  baseURI: `${worker}/`,
});
assert.deepEqual(documentRecoveredEmbed, hrefOnlyEmbed,
  'document.URL must recover the real navigation URL when Location getters are inaccessible');

const opaqueBlobLocation = {
  origin: 'null',
  pathname: '/runtime.js',
  search: '',
  href: 'blob:https://chatgpt.com/runtime',
};
assert.deepEqual(runtimeLocationFromSnapshot(chatgpt.href, opaqueBlobLocation), chatgpt,
  'a primitive href captured before Blob import must survive an opaque protected-runtime location');

const primitiveGlobals = {
  __HEX_RUNTIME_HOST_HREF__: embedHref,
  __HEX_RUNTIME_HOST_ORIGIN__: worker,
  __HEX_RUNTIME_HOST_PATHNAME__: '/embed/chatgpt',
  __HEX_RUNTIME_HOST_SEARCH__: '?__hex_embed_generation=42&__hex_ai_provider=chatgpt',
  __HEX_RUNTIME_HOST_LOCATION__: { origin: 'null', href: 'blob:https://invalid/runtime' },
};
const primitiveSnapshot = runtimeHostSnapshotFromGlobals(primitiveGlobals);
assert.equal(primitiveSnapshot.href, embedHref,
  'protected runtime must prefer primitive host fields over a cross-realm object snapshot');
const restoredEmbed = runtimeLocationFromSnapshot(primitiveSnapshot, opaqueBlobLocation);
assert.deepEqual(restoredEmbed, hrefOnlyEmbed,
  'iframe route and generation must survive Blob import through primitive globals');
assert.match(restoredEmbed.search, /__hex_embed_generation=42/,
  'captured iframe generation must remain available to the attach handshake');

const legacyObject = { origin: worker, pathname: '/', search: '', href: `${worker}/` };
assert.equal(runtimeHostSnapshotFromGlobals({ __HEX_RUNTIME_HOST_LOCATION__: legacyObject }), legacyObject,
  'the previous object snapshot remains a compatibility fallback when primitive globals are absent');

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
for (const field of ['HREF', 'ORIGIN', 'PATHNAME', 'SEARCH']) {
  assert.match(loaderSource, new RegExp(`__HEX_RUNTIME_HOST_${field}__\\s*=\\s*RUNTIME_HOST_LOCATION\\.${field.toLowerCase()}`));
}
assert.match(loaderSource, /__HEX_RUNTIME_HOST_LOCATION__\s*=\s*RUNTIME_HOST_LOCATION/);
assert.ok(loaderSource.indexOf('__HEX_RUNTIME_HOST_HREF__ = RUNTIME_HOST_LOCATION.href') < loaderSource.indexOf('import(blobUrl)'),
  'primitive host href must be published before protected runtime import');
assert.match(protectedEntrySource, /runtimeLocationFromSnapshot\(runtimeHostSnapshotFromGlobals\(\)\)/,
  'protected runtime must restore host identity from primitive globals before consulting Blob-world location');
assert.match(protectedEntrySource, /startEmbedChildRuntime\(\{\s*cssText:\s*PROTECTED_HOST\.css,\s*location:\s*runtimeLocation\s*\}\)/);
assert.doesNotMatch(protectedEntrySource, /globalThis\.document\?\.location\s*\|\|\s*globalThis\.location/,
  'protected entry must not directly re-read the post-import Blob-world location');
assert.match(protectedEntrySource, /runtimeLocation\.origin\s*!==\s*apiOrigin/,
  'strict runtime origin matching must remain enforced for Worker contexts');

console.log('userscript runtime host location: ok');
