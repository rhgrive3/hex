import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CHATGPT_ORIGINS, isAllowedRequestOrigin } from '../js/userscript/request-origin-policy.js';

const workerOrigin = 'https://ida.rhgrive.workers.dev';
for (const origin of [...CHATGPT_ORIGINS, workerOrigin]) {
  assert.equal(isAllowedRequestOrigin(origin, workerOrigin), true, `${origin} must be allowed`);
}
for (const origin of [null, undefined, '', 'null', 'https://chatgpt.com.evil.example', 'https://evil.example']) {
  assert.equal(isAllowedRequestOrigin(origin, workerOrigin), false, `${String(origin)} must be rejected`);
}

const workerEntry = fs.readFileSync(new URL('../worker-entry.js', import.meta.url), 'utf8');
assert.match(workerEntry, /if \(!isAllowedRequestOrigin\(origin, url\.origin\)\) return json\(\{ error: 'origin-not-allowed' \}, 403\);/);
assert.match(workerEntry, /apiPreflight\(origin, url\.origin\)/);
assert.match(workerEntry, /runtimePreflight\(request\.headers\.get\('origin'\), url\.origin\)/);
assert.doesNotMatch(workerEntry, /if \(origin && origin !== url\.origin && !CHATGPT_ORIGINS\.has\(origin\)\)/);

console.log('userscript worker origin policy: ok');
