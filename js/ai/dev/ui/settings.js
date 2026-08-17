import { AllowAllAdminProvider, readAdminIdentity } from '../auth/admin-provider.js';
import { AGENT_PROFILE, assertAgentProfile, availableAgentProfiles, canSelectAgentProfile } from '../policy/agent-profile.js';
import { DEV_DECISION_POLICY, assertDevDecisionPolicy } from '../policy/decision-policy.js';
import { createDevAnalysisScopeRequest, ANALYSIS_SCOPE_INITIALS } from '../run/analysis-scope.js';

const STORAGE_KEY = 'hex.ai.dev.settings.v1';

export class DevAgentUiSettings {
  constructor({ authProvider = new AllowAllAdminProvider(), storage = defaultStorage(), key = STORAGE_KEY } = {}) {
    this.authProvider = authProvider;
    this.identity = readAdminIdentity(authProvider);
    this.storage = storage;
    this.key = key;
    this.listeners = new Set();
    const saved = this.load();
    this.agentProfile = saved.agentProfile || AGENT_PROFILE.STANDARD;
    if (!canSelectAgentProfile(this.identity, this.agentProfile)) this.agentProfile = AGENT_PROFILE.STANDARD;
    this.decisionPolicy = safePolicy(saved.decisionPolicy);
    this.analysisScope = safeScope(saved.analysisScope);
    this.lastRun = null;
  }

  profiles() { return availableAgentProfiles(this.identity); }
  setAgentProfile(profile) {
    const next = assertAgentProfile(profile);
    if (!canSelectAgentProfile(this.identity, next)) throw new Error('Admin privileges are required for the Dev profile.');
    if (this.agentProfile === next) return false;
    this.agentProfile = next;
    this.persist(); this.emit(); return true;
  }
  setDecisionPolicy(policy) {
    const next = assertDevDecisionPolicy(policy);
    if (this.decisionPolicy === next) return false;
    this.decisionPolicy = next;
    this.persist(); this.emit(); return true;
  }
  setAnalysisScope(initial) {
    const normalized = String(initial || '').toLowerCase();
    if (!ANALYSIS_SCOPE_INITIALS.includes(normalized)) throw new TypeError(`Unsupported analysis scope: ${initial}`);
    const next = createDevAnalysisScopeRequest(normalized);
    if (this.analysisScope.initial === next.initial) return false;
    this.analysisScope = next;
    this.persist(); this.emit(); return true;
  }
  setLastRun(run) { this.lastRun = run || null; this.emit(); }
  on(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  snapshot() {
    return Object.freeze({
      identity: this.identity,
      agentProfile: this.agentProfile,
      decisionPolicy: this.decisionPolicy,
      analysisScope: this.analysisScope,
      lastRun: this.lastRun,
    });
  }
  emit() { for (const listener of this.listeners) { try { listener(this.snapshot()); } catch { /* isolated UI listener */ } } }
  load() {
    if (!this.storage) return {};
    try { const raw = this.storage.getItem(this.key); const parsed = raw ? JSON.parse(raw) : null; return parsed && typeof parsed === 'object' ? parsed : {}; }
    catch { return {}; }
  }
  persist() {
    if (!this.storage) return false;
    try {
      this.storage.setItem(this.key, JSON.stringify({
        agentProfile: this.agentProfile,
        decisionPolicy: this.decisionPolicy,
        analysisScope: this.analysisScope,
      }));
      return true;
    } catch { return false; }
  }
}

function safePolicy(value) { try { return assertDevDecisionPolicy(value || DEV_DECISION_POLICY.NORMAL); } catch { return DEV_DECISION_POLICY.NORMAL; } }
function safeScope(value) { try { return value?.initial ? createDevAnalysisScopeRequest(value.initial) : createDevAnalysisScopeRequest(); } catch { return createDevAnalysisScopeRequest(); } }
function defaultStorage() { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } }
