const GITHUB_API_ORIGIN = 'https://api.github.com';
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT_SHA = /^[a-f0-9]{7,40}$/i;
const SUCCESS_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const FAILURE_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);

export function createDevGithubReadRuntime({ requestJson = githubRequestJson, now = () => new Date().toISOString() } = {}) {
  if (typeof requestJson !== 'function') throw new TypeError('GitHub verification runtime requires requestJson.');
  return Object.freeze({
    async verifyPullRequest(args = {}, options = {}) {
      const repository = normalizeRepository(args.repository);
      const prNumber = normalizePrNumber(args.prNumber);
      const signal = options.signal || null;
      const repoPath = repository.split('/').map(encodeURIComponent).join('/');
      const pr = await requestJson(`${GITHUB_API_ORIGIN}/repos/${repoPath}/pulls/${prNumber}`, { signal });
      const headSha = normalizeCommitSha(pr?.head?.sha);
      const [commit, workflows, checks, legacy] = await Promise.all([
        requestJson(`${GITHUB_API_ORIGIN}/repos/${repoPath}/commits/${headSha}`, { signal }),
        requestJson(`${GITHUB_API_ORIGIN}/repos/${repoPath}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100`, { signal }),
        requestJson(`${GITHUB_API_ORIGIN}/repos/${repoPath}/commits/${headSha}/check-runs?per_page=100`, { signal }),
        requestJson(`${GITHUB_API_ORIGIN}/repos/${repoPath}/commits/${headSha}/status`, { signal }),
      ]);
      const workflowRuns = normalizeWorkflowRuns(workflows?.workflow_runs);
      const checkRuns = normalizeCheckRuns(checks?.check_runs);
      const commitStatuses = normalizeCommitStatuses(legacy?.statuses);
      return Object.freeze({
        source: 'github-rest-public', repository, verifiedAt: String(now()),
        pullRequest: Object.freeze({
          number: prNumber, state: stringOrNull(pr?.state), draft: !!pr?.draft, merged: !!pr?.merged,
          mergeable: typeof pr?.mergeable === 'boolean' ? pr.mergeable : null,
          baseRef: stringOrNull(pr?.base?.ref), baseSha: shaOrNull(pr?.base?.sha),
          headRef: stringOrNull(pr?.head?.ref), headSha, headRepository: stringOrNull(pr?.head?.repo?.full_name),
        }),
        commit: Object.freeze({ sha: normalizeCommitSha(commit?.sha), message: String(commit?.commit?.message || '').slice(0, 512) }),
        ci: Object.freeze({
          state: summarizeCi({ workflowRuns, checkRuns, commitStatuses, legacyState: legacy?.state }),
          legacyState: stringOrNull(legacy?.state), workflowRuns, checkRuns, commitStatuses,
        }),
      });
    },
  });
}

export async function githubRequestJson(url, { signal } = {}) {
  const target = new URL(String(url));
  if (target.origin !== GITHUB_API_ORIGIN) throw githubError('github-url-rejected', 'GitHub verification only permits api.github.com.');
  if (signal?.aborted) throw abortError(signal.reason);
  const gm = userscriptRequest();
  if (!gm) {
    const response = await fetch(target.href, { method: 'GET', headers: githubHeaders(), credentials: 'omit', cache: 'no-store', signal });
    return parseGithubResponse(response.status, await response.text());
  }
  return new Promise((resolve, reject) => {
    let settled = false, handle = null;
    const finish = (fn, value) => { if (settled) return; settled = true; signal?.removeEventListener?.('abort', onAbort); fn(value); };
    const onAbort = () => { try { handle?.abort?.(); } catch {} finish(reject, abortError(signal?.reason)); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      handle = gm({
        method: 'GET', url: target.href, headers: Object.fromEntries(githubHeaders().entries()), responseType: 'text',
        onload: (response) => { try { finish(resolve, parseGithubResponse(Number(response?.status) || 0, response?.responseText ?? response?.response ?? '')); } catch (error) { finish(reject, error); } },
        onerror: () => finish(reject, githubError('github-network-error', 'GitHub verification request failed.')),
        ontimeout: () => finish(reject, githubError('github-timeout', 'GitHub verification request timed out.')),
        onabort: () => finish(reject, abortError(signal?.reason)),
      });
      if (handle && typeof handle.catch === 'function') handle.catch((error) => finish(reject, error));
    } catch (error) { finish(reject, error); }
  });
}

function normalizeWorkflowRuns(values) {
  return Object.freeze((Array.isArray(values) ? values : []).slice(0, 100).map((run) => Object.freeze({
    id: finiteIntegerOrNull(run?.id), name: String(run?.name || '').slice(0, 160), event: String(run?.event || '').slice(0, 64),
    status: String(run?.status || '').slice(0, 64), conclusion: stringOrNull(run?.conclusion), headSha: shaOrNull(run?.head_sha), runNumber: finiteIntegerOrNull(run?.run_number),
  })));
}
function normalizeCheckRuns(values) {
  return Object.freeze((Array.isArray(values) ? values : []).slice(0, 100).map((run) => Object.freeze({
    id: finiteIntegerOrNull(run?.id), name: String(run?.name || '').slice(0, 160), status: String(run?.status || '').slice(0, 64), conclusion: stringOrNull(run?.conclusion),
  })));
}
function normalizeCommitStatuses(values) {
  return Object.freeze((Array.isArray(values) ? values : []).slice(0, 100).map((status) => Object.freeze({ context: String(status?.context || '').slice(0, 160), state: String(status?.state || '').slice(0, 64) })));
}
function summarizeCi({ workflowRuns, checkRuns, commitStatuses, legacyState }) {
  const legacy = String(legacyState || '').toLowerCase();
  if (legacy === 'failure' || legacy === 'error') return 'failure';
  if (legacy === 'pending') return 'pending';
  for (const item of [...workflowRuns, ...checkRuns]) {
    const status = String(item.status || '').toLowerCase();
    const conclusion = String(item.conclusion || '').toLowerCase();
    if (FAILURE_CONCLUSIONS.has(conclusion)) return 'failure';
    if (status && status !== 'completed') return 'pending';
    if (status === 'completed' && conclusion && !SUCCESS_CONCLUSIONS.has(conclusion)) return 'failure';
  }
  for (const item of commitStatuses) {
    const state = String(item.state || '').toLowerCase();
    if (state === 'failure' || state === 'error') return 'failure';
    if (state === 'pending') return 'pending';
  }
  const observed = workflowRuns.length + checkRuns.length + commitStatuses.length;
  return observed || legacy === 'success' ? 'success' : 'none';
}
function parseGithubResponse(status, body) {
  if (status < 200 || status >= 300) throw githubError(`github-http-${status || 0}`, `GitHub verification request failed with HTTP ${status || 0}.`);
  try { return JSON.parse(String(body || 'null')); } catch { throw githubError('github-invalid-json', 'GitHub verification returned invalid JSON.'); }
}
function githubHeaders() { return new Headers({ Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }); }
function userscriptRequest() { const modern = globalThis.GM?.xmlHttpRequest; if (typeof modern === 'function') return modern.bind(globalThis.GM); const legacy = globalThis.GM_xmlhttpRequest; return typeof legacy === 'function' ? legacy : null; }
function normalizeRepository(value) { const text = String(value || '').trim(); if (!REPOSITORY.test(text)) throw githubError('github-invalid-repository', 'GitHub repository must be owner/name.'); return text; }
function normalizePrNumber(value) { const number = Number(value); if (!Number.isSafeInteger(number) || number <= 0) throw githubError('github-invalid-pr', 'GitHub PR number must be a positive integer.'); return number; }
function normalizeCommitSha(value) { const text = String(value || '').trim(); if (!COMMIT_SHA.test(text)) throw githubError('github-invalid-sha', 'GitHub commit SHA is invalid.'); return text.toLowerCase(); }
function shaOrNull(value) { const text = String(value || '').trim(); return COMMIT_SHA.test(text) ? text.toLowerCase() : null; }
function stringOrNull(value) { return value == null ? null : String(value).slice(0, 256); }
function finiteIntegerOrNull(value) { return Number.isSafeInteger(Number(value)) ? Number(value) : null; }
function githubError(code, message) { const error = new Error(message); error.code = code; return error; }
function abortError(reason) { const error = githubError('cancelled', String(reason || 'cancelled')); error.name = 'AbortError'; return error; }
