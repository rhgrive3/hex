import { assertDevDecisionPolicy } from '../policy/decision-policy.js';

export const DEV_EXTENSION_API_VERSION = 'hex-dev-extension-v1';
export const DEV_BOOTSTRAP_EXTENSION_VERSION = '1';
export const DEV_BOOTSTRAP_CAPABILITY = 'dev.bootstrap.identity';
export const DEV_BOOTSTRAP_EXTENSION_INTEGRITY = 'sha256-555ab61a675c787b9d5f9d497eabd4593967867a81c0b03ee3ef5ee860b2e6fb';

const CHECKPOINT_KEYS = Object.freeze(['runId','goal','decisionPolicy','supervisorSessionKey','chatgptConversationId','pendingTask','expectedCommit','expectedBuildId','expectedExtensionVersion']);
const EXTENSION_KEYS = Object.freeze(['apiVersion','id','version','requiresReload','capabilities','integrity']);
const CAPABILITY_KEYS = Object.freeze(['name','kind']);
const TRUSTED_EXTENSIONS = Object.freeze({ [`dev.bootstrap-observer@${DEV_BOOTSTRAP_EXTENSION_VERSION}`]: DEV_BOOTSTRAP_EXTENSION_INTEGRITY });

export const DEV_BOOTSTRAP_EXTENSION = deepFreeze({ apiVersion: DEV_EXTENSION_API_VERSION, id: 'dev.bootstrap-observer', version: DEV_BOOTSTRAP_EXTENSION_VERSION, requiresReload: true, capabilities: [{ name: DEV_BOOTSTRAP_CAPABILITY, kind: 'identity' }], integrity: DEV_BOOTSTRAP_EXTENSION_INTEGRITY });

export function createDevBootstrapCheckpoint(value) {
  assertPlainObject(value, 'Dev bootstrap checkpoint'); assertExactKeys(value, CHECKPOINT_KEYS, 'Dev bootstrap checkpoint');
  return deepFreeze({ runId: nonEmpty(value.runId, 'runId'), goal: nonEmpty(value.goal, 'goal'), decisionPolicy: assertDevDecisionPolicy(value.decisionPolicy), supervisorSessionKey: nonEmpty(value.supervisorSessionKey, 'supervisorSessionKey'), chatgptConversationId: nonEmpty(value.chatgptConversationId, 'chatgptConversationId'), pendingTask: cloneJson(value.pendingTask, 'pendingTask'), expectedCommit: assertCommit(value.expectedCommit), expectedBuildId: assertBuildId(value.expectedBuildId), expectedExtensionVersion: nonEmpty(value.expectedExtensionVersion, 'expectedExtensionVersion') });
}
export function createDevBootstrapHandoff(checkpoint) { const value = createDevBootstrapCheckpoint(checkpoint); return deepFreeze({ runId: value.runId, supervisorSessionKey: value.supervisorSessionKey, chatgptConversationId: value.chatgptConversationId, checkpoint: value }); }
export function verifyDevBootstrapIdentity(checkpoint, activeIdentity, extensionVersion) {
  const expected = createDevBootstrapCheckpoint(checkpoint); assertPlainObject(activeIdentity, 'active Dev runtime identity');
  const actual = Object.freeze({ commit: assertCommit(activeIdentity.commit), buildId: assertBuildId(activeIdentity.buildId), extensionVersion: nonEmpty(extensionVersion, 'active extension version') });
  const mismatches = []; if (actual.commit !== expected.expectedCommit) mismatches.push('commit'); if (actual.buildId !== expected.expectedBuildId) mismatches.push('buildId'); if (actual.extensionVersion !== expected.expectedExtensionVersion) mismatches.push('extensionVersion');
  if (mismatches.length) { const error = new Error(`Dev bootstrap identity mismatch: ${mismatches.join(', ')}.`); error.code = 'dev-bootstrap-identity-mismatch'; error.mismatches = Object.freeze([...mismatches]); throw error; }
  return Object.freeze({ verified: true, ...actual });
}

export class DevExtensionLoader {
  #active = null; #activeIdentity = null; #staged = null; #toolCallDepth = 0; #sha256;
  constructor({ sha256 = sha256Hex } = {}) { if (typeof sha256 !== 'function') throw new TypeError('sha256 must be a function.'); this.#sha256 = sha256; }
  get toolCallActive() { return this.#toolCallDepth > 0; } get activeVersion() { return this.#active?.version || null; } get stagedVersion() { return this.#staged?.version || null; }
  beginToolCall() { this.#toolCallDepth += 1; return this.#toolCallDepth; }
  endToolCall() { if (this.#toolCallDepth <= 0) throw new Error('No Dev tool call is active.'); this.#toolCallDepth -= 1; return this.#toolCallDepth; }
  async stage(extension) {
    const normalized = normalizeExtension(extension); const trustedIntegrity = TRUSTED_EXTENSIONS[`${normalized.id}@${normalized.version}`];
    if (!trustedIntegrity) { const error = new Error('Dev extension identity is not trusted by this runtime.'); error.code = 'dev-extension-untrusted'; throw error; }
    const actual = `sha256-${await this.#sha256(canonicalExtensionPayload(normalized))}`;
    if (!constantTimeTextEqual(actual, trustedIntegrity) || !constantTimeTextEqual(normalized.integrity, trustedIntegrity)) { const error = new Error('Dev extension integrity verification failed.'); error.code = 'dev-extension-integrity-mismatch'; throw error; }
    this.#staged = normalized; return Object.freeze({ id: normalized.id, version: normalized.version, integrity: normalized.integrity, verified: true });
  }
  activateAtSafeBoundary({ checkpoint, activeIdentity, reinitialized = false } = {}) {
    if (this.toolCallActive) { const error = new Error('Dev extension activation is forbidden during a tool call.'); error.code = 'dev-extension-tool-call-active'; throw error; }
    if (!this.#staged) throw new Error('No verified Dev extension is staged.');
    const verifiedCheckpoint = createDevBootstrapCheckpoint(checkpoint);
    if (verifiedCheckpoint.expectedExtensionVersion !== this.#staged.version) { const error = new Error('Staged Dev extension version does not match the bootstrap checkpoint.'); error.code = 'dev-extension-version-mismatch'; throw error; }
    if (this.#staged.requiresReload && !reinitialized) return deepFreeze({ status: 'reload-required', reason: 'extension-reinitialize', expectedExtensionVersion: this.#staged.version, handoff: createDevBootstrapHandoff(verifiedCheckpoint) });
    const verifiedIdentity = verifyDevBootstrapIdentity(verifiedCheckpoint, activeIdentity, this.#staged.version); this.#active = this.#staged; this.#activeIdentity = verifiedIdentity;
    return deepFreeze({ status: 'active', extensionId: this.#active.id, extensionVersion: this.#active.version, integrity: this.#active.integrity, identity: verifiedIdentity });
  }
  invoke(name) {
    if (!this.#active) throw new Error('No Dev extension is active.'); const capability = this.#active.capabilities.find((item) => item.name === String(name || ''));
    if (!capability) throw new Error(`Unknown Dev extension capability: ${name}`); if (capability.kind !== 'identity') throw new Error(`Unsupported Dev extension capability kind: ${capability.kind}`);
    return deepFreeze({ capability: capability.name, extensionId: this.#active.id, extensionVersion: this.#active.version, integrity: this.#active.integrity, commit: this.#activeIdentity.commit, buildId: this.#activeIdentity.buildId, verified: true });
  }
}
function normalizeExtension(value) {
  assertPlainObject(value, 'Dev extension'); assertExactKeys(value, EXTENSION_KEYS, 'Dev extension'); if (value.apiVersion !== DEV_EXTENSION_API_VERSION) throw new TypeError(`Unsupported Dev extension API version: ${value.apiVersion}`); if (typeof value.requiresReload !== 'boolean') throw new TypeError('requiresReload must be boolean.'); if (!Array.isArray(value.capabilities) || value.capabilities.length === 0) throw new TypeError('Dev extension capabilities are required.');
  const seen = new Set(); const capabilities = value.capabilities.map((item) => { assertPlainObject(item, 'Dev extension capability'); assertExactKeys(item, CAPABILITY_KEYS, 'Dev extension capability'); const capability = { name: nonEmpty(item.name, 'capability.name'), kind: nonEmpty(item.kind, 'capability.kind') }; if (seen.has(capability.name)) throw new TypeError(`Duplicate Dev extension capability: ${capability.name}`); seen.add(capability.name); if (capability.kind !== 'identity') throw new TypeError(`Unsupported Dev extension capability kind: ${capability.kind}`); return capability; });
  return deepFreeze({ apiVersion: value.apiVersion, id: nonEmpty(value.id, 'extension.id'), version: nonEmpty(value.version, 'extension.version'), requiresReload: value.requiresReload, capabilities, integrity: assertIntegrity(value.integrity) });
}
function canonicalExtensionPayload(value) { return JSON.stringify({ apiVersion: value.apiVersion, id: value.id, version: value.version, requiresReload: value.requiresReload, capabilities: value.capabilities.map(({ name, kind }) => ({ name, kind })) }); }
async function sha256Hex(text) { if (!globalThis.crypto?.subtle) throw new Error('WebCrypto SHA-256 is unavailable.'); const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)))); return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
function constantTimeTextEqual(left, right) { const a = String(left || ''), b = String(right || ''); let diff = a.length ^ b.length; const length = Math.max(a.length, b.length); for (let i = 0; i < length; i += 1) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return diff === 0; }
function assertPlainObject(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new TypeError(`${label} must be a plain object.`); }
function assertExactKeys(value, keys, label) { const actual = Object.keys(value).sort(), expected = [...keys].sort(); if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(`${label} has an invalid shape.`); }
function nonEmpty(value, field) { const text = String(value || '').trim(); if (!text) throw new TypeError(`${field} is required.`); return text; }
function assertCommit(value) { const text = nonEmpty(value, 'expectedCommit'); if (!/^[0-9a-f]{40}$/i.test(text)) throw new TypeError('expectedCommit must be a full Git commit SHA.'); return text.toLowerCase(); }
function assertBuildId(value) { const text = nonEmpty(value, 'expectedBuildId'); if (!/^[0-9a-f]{24}$/i.test(text)) throw new TypeError('expectedBuildId must be a 24-character runtime build ID.'); return text.toLowerCase(); }
function assertIntegrity(value) { const text = nonEmpty(value, 'extension.integrity'); if (!/^sha256-[0-9a-f]{64}$/i.test(text)) throw new TypeError('extension.integrity must be a SHA-256 identity.'); return text.toLowerCase(); }
function cloneJson(value, field) { if (value === undefined) throw new TypeError(`${field} must be JSON-safe.`); try { return JSON.parse(JSON.stringify(value)); } catch { throw new TypeError(`${field} must be JSON-safe.`); } }
function deepFreeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; }
