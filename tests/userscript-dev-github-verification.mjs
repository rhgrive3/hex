import assert from 'node:assert/strict';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';
import { createDevGithubReadRuntime } from '../js/userscript/dev/github-read-runtime.js';
import { createDevWorkerParentRpc, createDevWorkerParentRpcClient } from '../js/userscript/dev/parent-rpc.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

await testGitHubReadNormalization();
await testGitHubFailureAndValidation();
await testGitHubVerificationCrossesParentRpc();
testUserscriptMetadataAllowsGitHub();
console.log('userscript Dev GitHub verification passed');

async function testGitHubReadNormalization() {
  const sha = 'e85411ebfc401f2de22e8f605cbc90399eaadd27';
  const calls = [];
  const runtime = createDevGithubReadRuntime({
    now: () => '2026-08-18T02:00:00.000+09:00',
    requestJson: async (url, { signal } = {}) => {
      calls.push({ url, signal });
      if (url.endsWith('/pulls/736')) return {
        state: 'open', draft: false, merged: false, mergeable: true,
        base: { ref: 'main', sha: 'f32eab2fe42de4d47d9aa757c768844f3e7301a0' },
        head: { ref: 'test/dev-worker-supervisor-anchor-refresh', sha, repo: { full_name: 'rhgrive3/hex' } },
      };
      if (url.endsWith(`/commits/${sha}`)) return { sha, commit: { message: 'test: regression' } };
      if (url.includes('/actions/runs?')) return { workflow_runs: [
        { id: 1, name: 'Invariant Gates', event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: sha, run_number: 777 },
        { id: 2, name: 'Universal binary platform', event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: sha, run_number: 1444 },
      ] };
      if (url.endsWith(`/commits/${sha}/check-runs?per_page=100`)) return { check_runs: [
        { id: 3, name: 'check-test', status: 'completed', conclusion: 'success' },
      ] };
      if (url.endsWith(`/commits/${sha}/status`)) return { state: 'success', statuses: [] };
      throw new Error(`unexpected URL ${url}`);
    },
  });
  const result = await runtime.verifyPullRequest({ repository: 'rhgrive3/hex', prNumber: 736 });
  assert.equal(result.source, 'github-rest-public');
  assert.equal(result.pullRequest.headSha, sha);
  assert.equal(result.pullRequest.headRef, 'test/dev-worker-supervisor-anchor-refresh');
  assert.equal(result.commit.sha, sha);
  assert.equal(result.ci.state, 'success');
  assert.equal(result.ci.workflowRuns.length, 2);
  assert.equal(calls.length, 5, 'PR, commit, Actions, checks, and legacy status must all be independently read');
  assert.ok(calls.every((call) => call.url.startsWith('https://api.github.com/repos/rhgrive3/hex/')));
}

async function testGitHubFailureAndValidation() {
  let calls = 0;
  const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const runtime = createDevGithubReadRuntime({
    requestJson: async (url) => {
      calls++;
      if (url.endsWith('/pulls/1')) return { head: { sha, ref: 'branch', repo: { full_name: 'rhgrive3/hex' } }, base: { ref: 'main', sha } };
      if (url.endsWith(`/commits/${sha}`)) return { sha, commit: { message: 'x' } };
      if (url.includes('/actions/runs?')) return { workflow_runs: [{ id: 1, name: 'CI', status: 'completed', conclusion: 'failure', head_sha: sha }] };
      if (url.includes('/check-runs?')) return { check_runs: [] };
      if (url.endsWith('/status')) return { state: 'success', statuses: [] };
      throw new Error('unexpected');
    },
  });
  const failed = await runtime.verifyPullRequest({ repository: 'rhgrive3/hex', prNumber: 1 });
  assert.equal(failed.ci.state, 'failure', 'one failed independent workflow must fail the normalized CI state');
  const before = calls;
  await assert.rejects(() => runtime.verifyPullRequest({ repository: 'https://evil.invalid/x', prNumber: 1 }), (error) => error.code === 'github-invalid-repository');
  await assert.rejects(() => runtime.verifyPullRequest({ repository: 'rhgrive3/hex', prNumber: 0 }), (error) => error.code === 'github-invalid-pr');
  assert.equal(calls, before, 'invalid tool arguments must be rejected before any network read');
}

async function testGitHubVerificationCrossesParentRpc() {
  const channel = new MessageChannel();
  let observed = null;
  const runtime = {
    async verifyPullRequest(args, options) {
      observed = { args, signal: options.signal };
      return {
        source: 'github-rest-public', repository: args.repository, verifiedAt: 'now',
        pullRequest: { number: args.prNumber, headSha: 'b'.repeat(40) },
        commit: { sha: 'b'.repeat(40), message: 'ok' },
        ci: { state: 'success', workflowRuns: [], checkRuns: [], commitStatuses: [] },
      };
    },
  };
  const server = createDevWorkerParentRpc({ port: channel.port1, runtime });
  const client = createDevWorkerParentRpcClient({ port: channel.port2, timeoutMs: 300 });
  const result = await client.verifyPullRequest({ repository: 'rhgrive3/hex', prNumber: 736 });
  assert.equal(result.ci.state, 'success');
  assert.deepEqual(observed.args, { repository: 'rhgrive3/hex', prNumber: 736 });
  assert.equal(observed.signal instanceof AbortSignal, true);
  client.close(); server.close();
}

function testUserscriptMetadataAllowsGitHub() {
  const source = fs.readFileSync(new URL('../scripts/build-userscript.mjs', import.meta.url), 'utf8');
  assert.match(source, /@connect\s+api\.github\.com/, 'userscript metadata must explicitly permit parent-side GitHub REST verification');
}
