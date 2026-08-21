import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GENERATED_OUTPUT_MODE,
  generatedOutputMode,
  shouldEnforceGeneratedOutput,
} from '../../tools/validation/generated-output-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const component = { eventName: 'pull_request', headRef: 'dev-agent-hardening/b-pool-wait-result' };
const integration = { eventName: 'pull_request', headRef: 'dev-agent-hardening/integration/checkpoint-b' };

assert.equal(generatedOutputMode(component), GENERATED_OUTPUT_MODE.EPHEMERAL);
assert.equal(shouldEnforceGeneratedOutput(component), false);
assert.equal(generatedOutputMode(integration), GENERATED_OUTPUT_MODE.ENFORCE);
assert.equal(generatedOutputMode({ eventName: 'pull_request', headRef: 'feature/userscript-change' }), GENERATED_OUTPUT_MODE.ENFORCE);
assert.equal(generatedOutputMode({ eventName: 'push', ref: 'refs/heads/main' }), GENERATED_OUTPUT_MODE.ENFORCE);
assert.equal(generatedOutputMode({ eventName: 'workflow_dispatch' }), GENERATED_OUTPUT_MODE.ENFORCE);
assert.equal(generatedOutputMode({ eventName: 'pull_request', headRef: 'dev-agent-hardening/' }), GENERATED_OUTPUT_MODE.EPHEMERAL);

for (const workflow of [
  '.github/workflows/generated-sync.yml',
  '.github/workflows/generated-userscript-autofix.yml',
  '.github/workflows/userscript-host.yml',
  '.github/workflows/phase7-release-validation.yml',
  'tests/semantic-v2/integration-userscript-sync.test.mjs',
]) {
  const source = fs.readFileSync(path.join(ROOT, workflow), 'utf8');
  assert.match(source, /tools\/validation\/generated-output-policy\.mjs/, `${workflow} must use the canonical policy`);
  if (workflow.startsWith('.github/')) {
    assert.match(source, /steps\.generated-policy\.outputs\.mode/, `${workflow} must honor the canonical policy result`);
    if (workflow.endsWith('/phase7-release-validation.yml')) {
      assert.match(source, /set -euo pipefail/, 'Phase 7 policy resolution must fail closed on command errors');
      assert.match(source, /case \"\$mode\" in/, 'Phase 7 policy resolution must validate its output');
      assert.match(source, /enforce\|ephemeral/, 'Phase 7 policy resolution must whitelist only known modes');
      assert.match(source, /exit 1/, 'Phase 7 policy resolution must reject unknown modes');
    }
  }
}
console.log('generated output policy: ok');
