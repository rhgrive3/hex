import assert from 'node:assert/strict';
import { gmFetch, installUserscriptNetworkBridge } from '../js/userscript/network.js';

const originalFetch = globalThis.fetch;
const originalGM = globalThis.GM;
const originalLocation = globalThis.location;
const requests = [];

try {
  Object.defineProperty(globalThis, 'location', { value: new URL('https://chatgpt.com/c/test'), configurable: true, writable: true });
  globalThis.GM = {
    xmlHttpRequest(details) {
      requests.push(details);
      let aborted = false;
      const handle = {
        abort() {
          aborted = true;
          queueMicrotask(() => details.onabort?.({ status: 0 }));
        },
      };
      queueMicrotask(() => {
        if (aborted) return;
        const bytes = new TextEncoder().encode('gm-ok');
        details.onload?.({
          status: 200,
          statusText: 'OK',
          response: bytes.buffer,
          responseHeaders: 'content-type: text/plain\r\nx-test: yes\r\n',
        });
      });
      return handle;
    },
  };

  {
    const response = await gmFetch('https://ida.example/api/ai/turn', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"x":1}',
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'gm-ok');
    assert.equal(response.headers.get('x-test'), 'yes');
    assert.equal(requests.at(-1).method, 'POST');
    assert.equal(requests.at(-1).data, '{"x":1}');
  }

  {
    let nativeCalls = 0;
    globalThis.fetch = async (input) => {
      nativeCalls++;
      return new Response(String(input));
    };
    globalThis.__HEX_API_BASE__ = 'https://ida.example/';
    installUserscriptNetworkBridge();

    const bridged = await globalThis.fetch('/api/ai/turn', { method: 'POST', body: '{}' });
    assert.equal(await bridged.text(), 'gm-ok');
    assert.equal(requests.at(-1).url, 'https://ida.example/api/ai/turn');

    const native = await globalThis.fetch('https://example.com/x');
    assert.equal(await native.text(), 'https://example.com/x');
    assert.equal(nativeCalls, 1);
  }

  {
    globalThis.fetch = originalFetch;
    delete globalThis.__HEX_NATIVE_FETCH__;
    const controller = new AbortController();
    const pending = gmFetch('https://ida.example/api/ai/turn', { signal: controller.signal });
    controller.abort('stop');
    await assert.rejects(pending, (error) => error?.name === 'AbortError');
  }

  console.log('userscript-network: ok');
} finally {
  globalThis.fetch = originalFetch;
  if (originalGM === undefined) delete globalThis.GM; else globalThis.GM = originalGM;
  if (originalLocation === undefined) delete globalThis.location;
  else Object.defineProperty(globalThis, 'location', { value: originalLocation, configurable: true, writable: true });
  delete globalThis.__HEX_API_BASE__;
  delete globalThis.__HEX_NATIVE_FETCH__;
}
