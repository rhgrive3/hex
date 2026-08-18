/* A merged source change is not a live runtime change. The parent userscript
   runtime keeps running the build it was loaded with, so proving a new
   capability against it proves nothing. This gate holds the expected runtime
   identity, demands a reload/reinitialize, re-reads the identity that is
   actually active, and refuses capability proofs until the two match. */

export const DEV_RUNTIME_IDENTITY_TOOL = 'dev.runtime.identity';
export const DEV_RUNTIME_ACTIVATION_TOOL = 'dev.runtime.require_activation';

export const DEV_SELF_UPDATE_STATE = Object.freeze({
  IDLE: 'idle',
  RELOAD_REQUIRED: 'reload-required',
  ACTIVE: 'active',
});
export const DEV_SELF_UPDATE_REJECTION_CODE = 'dev-self-update-reload-required';
export const DEV_SELF_UPDATE_ACTION = 'reload-and-reinitialize';
export const DEV_SELF_UPDATE_HISTORY_KIND = 'runtime-activation-required';

const COMMIT = /^[0-9a-f]{40}$/;
const BUILD_ID = /^[0-9a-f]{24}$/;

/* Reading the active identity and withdrawing a wrong expectation are how the
   gate is satisfied or corrected, and winding an in-flight Worker down is
   cleanup rather than a capability proof. None of them may ever be gated. */
const ALWAYS_ALLOWED = new Set([
  DEV_RUNTIME_IDENTITY_TOOL,
  DEV_RUNTIME_ACTIVATION_TOOL,
  'worker.release',
  'worker.stop',
  'worker.pool.release',
  'worker.pool.stop',
]);

export class DevSelfUpdateGate {
  #expected = null;
  #active = null;
  #capabilities = new Set();
  #mismatches = [];
  #reason = null;
  #observed = false;
  #requireReinitialization = false;
  #reinitialized = false;

  get state() {
    if (!this.#expected) return DEV_SELF_UPDATE_STATE.IDLE;
    return this.#observed && this.#mismatches.length === 0
      ? DEV_SELF_UPDATE_STATE.ACTIVE
      : DEV_SELF_UPDATE_STATE.RELOAD_REQUIRED;
  }

  get expectedIdentity() { return this.#expected; }
  get activeIdentity() { return this.#active; }

  /* Arm the gate for a source change that is merged but not yet running. */
  requireActivation({ expectedCommit, expectedBuildId, expectedUserscriptVersion = null, capabilities = [], reason = null, requireReinitialization = false, clear = false } = {}) {
    /* A mistyped expectation must not be able to brick the Dev tool surface
       for the rest of the page session, so the declaring side can withdraw it. */
    if (clear === true) return this.clear(reason);
    const expected = Object.freeze({
      commit: assertCommit(expectedCommit, 'expectedCommit'),
      buildId: assertBuildId(expectedBuildId, 'expectedBuildId'),
      userscriptVersion: optionalText(expectedUserscriptVersion, 'expectedUserscriptVersion'),
    });
    this.#expected = expected;
    this.#capabilities = new Set(assertCapabilities(capabilities));
    this.#reason = optionalText(reason, 'reason');
    /* Anything observed before the update was observed on the old runtime. */
    this.#active = null;
    this.#observed = false;
    this.#requireReinitialization = requireReinitialization === true;
    this.#reinitialized = false;
    this.#mismatches = ['not-observed'];
    return this.status();
  }

  /* Re-read of the identity that is actually active right now. */
  observeActiveRuntime(identity, { reinitialized = false } = {}) {
    const active = normalizeObservedIdentity(identity);
    this.#active = active;
    if (reinitialized === true) this.#reinitialized = true;
    if (!this.#expected) {
      this.#observed = false;
      this.#mismatches = [];
      return this.status();
    }
    this.#observed = true;
    const mismatches = compareIdentity(this.#expected, active);
    /* A matching identity read on a runtime that was never reinitialized is
       the exact stale-proof this gate exists to refuse. */
    if (this.#requireReinitialization && !this.#reinitialized) mismatches.push('reinitialization');
    this.#mismatches = mismatches;
    return this.status();
  }

  blocks(tool) {
    const name = String(tool || '');
    if (!name || ALWAYS_ALLOWED.has(name)) return false;
    if (this.state !== DEV_SELF_UPDATE_STATE.RELOAD_REQUIRED) return false;
    return this.#capabilities.size === 0 || this.#capabilities.has(name);
  }

  rejectionFor(tool) {
    if (!this.blocks(tool)) return null;
    return Object.freeze({
      code: DEV_SELF_UPDATE_REJECTION_CODE,
      action: DEV_SELF_UPDATE_ACTION,
      tool: String(tool || ''),
      identityTool: DEV_RUNTIME_IDENTITY_TOOL,
      message: this.#observed
        ? `現在activeなruntime identityはexpected identityと一致していない (${this.#mismatches.join(', ')})。stale runtimeでのproofは拒否される。reload/reinitializeのうえ ${DEV_RUNTIME_IDENTITY_TOOL} でactive identityを取り直し、一致を確認してから再実行すること。`
        : `merge済みのsource変更はまだactive runtimeに反映されていない。reload/reinitializeのうえ ${DEV_RUNTIME_IDENTITY_TOOL} でactive identityを取得し、expected identityと一致することを確認するまで、この能力のE2E proofは禁止。`,
      ...this.status(),
    });
  }

  status() {
    return Object.freeze({
      state: this.state,
      observed: this.#observed,
      reinitialized: this.#reinitialized,
      requiresReinitialization: this.#requireReinitialization,
      reason: this.#reason,
      expected: this.#expected,
      active: this.#active,
      mismatches: Object.freeze([...this.#mismatches]),
      gatedCapabilities: Object.freeze([...this.#capabilities]),
    });
  }

  clear(reason = null) {
    this.#expected = null;
    this.#active = null;
    this.#capabilities = new Set();
    this.#mismatches = [];
    this.#reason = optionalText(reason, 'reason');
    this.#observed = false;
    this.#requireReinitialization = false;
    this.#reinitialized = false;
    return this.status();
  }
}

function compareIdentity(expected, active) {
  const mismatches = [];
  if (expected.commit !== active.commit) mismatches.push('commit');
  if (expected.buildId !== active.buildId) mismatches.push('buildId');
  if (expected.userscriptVersion && expected.userscriptVersion !== active.userscriptVersion) mismatches.push('userscriptVersion');
  return mismatches;
}

/* Accepts the identity shapes the runtime already publishes:
   Dev bootstrap evidence, the parent bootstrap host, and the secure loader. */
function normalizeObservedIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw identityError('active Dev runtime identity must be an object.');
  }
  const commit = String(value.commit ?? value.sourceCommit ?? '').trim().toLowerCase();
  const buildId = String(value.buildId ?? '').trim().toLowerCase();
  if (!COMMIT.test(commit)) throw identityError('active runtime commit identity is unavailable.');
  if (!BUILD_ID.test(buildId)) throw identityError('active runtime build identity is unavailable.');
  const userscriptVersion = String(value.userscriptVersion ?? value.loaderVersion ?? value.version ?? '').trim();
  return Object.freeze({ commit, buildId, userscriptVersion: userscriptVersion || null });
}

function identityError(message) {
  const error = new TypeError(`Dev self-update gate: ${message}`);
  error.code = 'dev-runtime-identity-unreadable';
  return error;
}

function assertCapabilities(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError('capabilities must be an array of tool names.');
  return value.map((item) => {
    const name = String(item || '').trim();
    if (!name) throw new TypeError('capabilities entries must be non-empty tool names.');
    return name;
  });
}

function assertCommit(value, field) {
  const text = String(value || '').trim().toLowerCase();
  if (!COMMIT.test(text)) throw new TypeError(`${field} must be a full Git commit SHA.`);
  return text;
}

function assertBuildId(value, field) {
  const text = String(value || '').trim().toLowerCase();
  if (!BUILD_ID.test(text)) throw new TypeError(`${field} must be a 24-character runtime build ID.`);
  return text;
}

function optionalText(value, field) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!text) throw new TypeError(`${field} must be a non-empty string when provided.`);
  return text.slice(0, 128);
}

/* The identity of the Dev runtime that is executing right now, read from the
   globals the secure loader publishes. This is the fallback the Supervisor
   needs when the parent build predates the dev.runtime.identity RPC method —
   the exact stale runtime the gate exists to catch. */
export function readDevRuntimeIdentityFromGlobals(globalObject = globalThis, overrides = {}) {
  const loader = safeRead(globalObject, '__HEX_SECURE_LOADER__') || {};
  const commit = normalizeCommitText(overrides.commit ?? overrides.sourceCommit ?? safeRead(globalObject, '__HEX_DEPLOYMENT_COMMIT__'));
  const buildId = normalizeBuildIdText(overrides.buildId ?? loader.buildId);
  const userscriptVersion = normalizeVersionText(overrides.userscriptVersion ?? overrides.loaderVersion ?? loader.version);
  return Object.freeze({
    commit,
    buildId,
    userscriptVersion,
    readable: !!commit && !!buildId,
    observedAt: new Date().toISOString(),
  });
}

export function normalizeCommitText(value) { const text = String(value ?? '').trim().toLowerCase(); return COMMIT.test(text) ? text : null; }
export function normalizeBuildIdText(value) { const text = String(value ?? '').trim().toLowerCase(); return BUILD_ID.test(text) ? text : null; }
export function normalizeVersionText(value) { const text = String(value ?? '').trim(); return text ? text.slice(0, 128) : null; }
function safeRead(value, key) { try { return value?.[key]; } catch { return null; } }
