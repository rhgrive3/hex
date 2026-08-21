import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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

const phase7Workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/phase7-release-validation.yml'), 'utf8');
const resolverMatch = /      - name: Resolve generated-output ownership policy[\s\S]*?        run: \|\n((?:          .*\n)+?)      - name: Generated-output synchronization/.exec(phase7Workflow);
assert.ok(resolverMatch, 'Phase 7 generated-output resolver step must remain extractable for fail-closed testing');
const resolverScript = resolverMatch[1]
  .split('\n')
  .filter(Boolean)
  .map((line) => line.slice(10))
  .join('\n');

function runResolver(fakeNodeBody = null) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-generated-policy-'));
  const outputFile = path.join(directory, 'github-output');
  // The workflow resolver test exercises its fail-closed default context. A
  // PR checkout inherits the host's GitHub event variables, which would make
  // the same valid command resolve to the component-lane `ephemeral` mode and
  // turn this context-independent contract test into an environment leak.
  const environment = {
    ...process.env,
    GITHUB_EVENT_NAME: '',
    GITHUB_HEAD_REF: '',
    GITHUB_REF: '',
    GITHUB_OUTPUT: outputFile,
  };
  if (fakeNodeBody != null) {
    const fakeBin = path.join(directory, 'bin');
    fs.mkdirSync(fakeBin);
    const fakeNode = path.join(fakeBin, 'node');
    fs.writeFileSync(fakeNode, `#!/usr/bin/env bash\n${fakeNodeBody}\n`, 'utf8');
    fs.chmodSync(fakeNode, 0o755);
    environment.PATH = `${fakeBin}${path.delimiter}${process.env.PATH || ''}`;
  }
  try {
    const result = spawnSync('bash', ['-c', resolverScript], {
      cwd: ROOT,
      env: environment,
      encoding: 'utf8',
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      output: fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '',
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const validResolver = runResolver();
assert.equal(validResolver.status, 0, `valid generated-output resolver failed: ${validResolver.stderr}`);
assert.match(validResolver.output, /^mode=enforce\s*$/m);

const failedNode = runResolver('exit 42');
assert.notEqual(failedNode.status, 0, 'generated-output resolver must fail when its Node policy command fails');
assert.equal(failedNode.output, '', 'failed policy command must not publish an empty mode');

const unknownMode = runResolver('printf "mystery\\n"');
assert.notEqual(unknownMode.status, 0, 'generated-output resolver must reject an unknown mode');
assert.match(unknownMode.stderr, /unknown generated-output policy mode/);

console.log('generated output policy: ok');
