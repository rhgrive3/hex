import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LEGACY_MODE, SANDBOX_MODE, readTrustedEmbedMode } from '../js/userscript/embed-mode.js';

assert.equal(readTrustedEmbedMode({}), SANDBOX_MODE, 'default mode must be sandbox');
assert.equal(readTrustedEmbedMode({ __HEX_EMBED_MODE__: SANDBOX_MODE }), SANDBOX_MODE, 'explicit sandbox mode must stay sandboxed');
assert.equal(readTrustedEmbedMode({ __HEX_EMBED_MODE__: 'iframe-v1' }), SANDBOX_MODE, 'retired iframe mode must not weaken isolation');
assert.equal(readTrustedEmbedMode({ __HEX_EMBED_MODE__: 'unknown-mode' }), SANDBOX_MODE, 'unknown mode must fail closed');
assert.equal(readTrustedEmbedMode({ __HEX_EMBED_MODE__: LEGACY_MODE }), LEGACY_MODE, 'explicit userscript rollback must remain available');
assert.equal(
  readTrustedEmbedMode({ localStorage: { getItem: () => LEGACY_MODE } }),
  SANDBOX_MODE,
  'page-origin storage must not downgrade the opaque sandbox',
);
const throwingOverride = {};
Object.defineProperty(throwingOverride, '__HEX_EMBED_MODE__', { get() { throw new Error('blocked realm'); } });
assert.equal(readTrustedEmbedMode(throwingOverride), SANDBOX_MODE, 'unreadable override must fail closed');

const entry = await readFile(new URL('../js/userscript/entry.js', import.meta.url), 'utf8');
assert.doesNotMatch(entry, /hex\.embed\.mode|EMBED_MODE_KEY/, 'entry must not consume page-origin embed-mode storage');
assert.match(entry, /readTrustedEmbedMode\(\)/, 'entry must use the trusted embed-mode resolver');

console.log('userscript embed mode security: ok');
