import assert from 'node:assert/strict';
import { readDevBootstrapRequested, shouldEnableDevBootstrap } from '../../js/userscript/embed-bootstrap.js';
import { runProductionDevBootstrap } from '../../js/ai/dev/bootstrap/production-bootstrap.js';

const COMMIT = 'a'.repeat(40);
const BUILD = 'b'.repeat(24);

assert.equal(readDevBootstrapRequested({ search: '' }), false);
assert.equal(readDevBootstrapRequested({ search: '?__hex_dev_bootstrap=0' }), false);
assert.equal(readDevBootstrapRequested({ search: '?__hex_dev_bootstrap=1' }), true);
assert.equal(readDevBootstrapRequested({ href: 'https://chatgpt.com/?__hex_dev_bootstrap=1' }), true);
assert.equal(shouldEnableDevBootstrap({ sourceCommit: COMMIT, buildId: BUILD, locationRef: { search: '' } }), false, 'deployment identity alone must not enable Dev bootstrap');
assert.equal(shouldEnableDevBootstrap({ sourceCommit: COMMIT, buildId: BUILD, locationRef: { search: '?__hex_dev_bootstrap=1' } }), true);
assert.equal(shouldEnableDevBootstrap({ sourceCommit: null, buildId: BUILD, locationRef: { search: '?__hex_dev_bootstrap=1' } }), false);
assert.equal(shouldEnableDevBootstrap({ sourceCommit: COMMIT, buildId: null, locationRef: { search: '?__hex_dev_bootstrap=1' } }), false);

const parent = {};
const globalObject = {
  parent,
  location: { href: 'about:srcdoc', origin: 'null', pathname: '', search: '' },
  __HEX_RUNTIME_HOST_HREF__: 'https://ida.rhgrive.workers.dev/embed/chatgpt?__hex_embed_generation=1',
  __HEX_RUNTIME_HOST_ORIGIN__: 'https://ida.rhgrive.workers.dev',
  __HEX_RUNTIME_HOST_PATHNAME__: '/embed/chatgpt',
  __HEX_RUNTIME_HOST_SEARCH__: '?__hex_embed_generation=1',
  __HEX_RUNTIME_HOST_LOCATION__: {
    href: 'https://ida.rhgrive.workers.dev/embed/chatgpt?__hex_embed_generation=1',
    origin: 'https://ida.rhgrive.workers.dev',
    pathname: '/embed/chatgpt',
    search: '?__hex_embed_generation=1',
  },
};
let prepared = false;
const result = await runProductionDevBootstrap({
  engine: { devBootstrap: { prepare: async () => { prepared = true; } } },
  session: { current: { id: 'standard-startup' } },
  bridge: { request: async () => { throw new Error('normal startup must not send a bootstrap prompt'); } },
  globalObject,
});
assert.equal(result.state, 'skipped');
assert.equal(result.reason, 'production-bootstrap-disabled');
assert.equal(prepared, false);
console.log('Dev bootstrap explicit opt-in: ok');
