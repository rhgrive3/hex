import { AI_MODES, AI_SCOPES, AI_STYLES } from '../schema.js';

let sessionSequence = 1;
const MEMORY_KEYS = ['goal','anchor','confirmedFacts','activeHypotheses','rejectedHypotheses','unresolvedQuestions','userConstraints','importantPriorActions'];

export function createInvestigationMemory(input = {}) {
  return {
    goal: String(input.goal || ''),
    anchor: input.anchor && typeof input.anchor === 'object' ? { ...input.anchor } : null,
    confirmedFacts: bounded(input.confirmedFacts, 64),
    activeHypotheses: bounded(input.activeHypotheses, 48),
    rejectedHypotheses: bounded(input.rejectedHypotheses, 48),
    unresolvedQuestions: bounded(input.unresolvedQuestions, 32),
    userConstraints: bounded(input.userConstraints, 32),
    importantPriorActions: bounded(input.importantPriorActions, 48),
  };
}

export function createInvestigationSession(input = {}) {
  const now = new Date().toISOString();
  return {
    id: String(input.id || `ai_${Date.now().toString(36)}_${sessionSequence++}`),
    binaryId: input.binaryId == null ? null : String(input.binaryId),
    binaryIdentity: input.binaryIdentity && typeof input.binaryIdentity === 'object' ? { ...input.binaryIdentity } : null,
    projectId: input.projectId == null ? null : String(input.projectId),
    mode: AI_MODES.includes(input.mode) ? input.mode : 'chat',
    style: AI_STYLES.includes(input.style) ? input.style : 'analyst',
    scope: AI_SCOPES.includes(input.scope) ? input.scope : 'auto',
    effectiveScope: AI_SCOPES.includes(input.effectiveScope) ? input.effectiveScope : null,
    goal: String(input.goal || ''),
    messages: Array.isArray(input.messages) ? input.messages.slice(-100) : [],
    summary: String(input.summary || ''), // legacy persistence only; no longer accumulates transcript data
    investigationMemory: createInvestigationMemory(input.investigationMemory || { goal: input.goal }),
    pinnedEvidence: Array.isArray(input.pinnedEvidence) ? Array.from(new Set(input.pinnedEvidence.map(String))) : [],
    hypotheses: Array.isArray(input.hypotheses) ? input.hypotheses : [],
    confirmedFindings: Array.isArray(input.confirmedFindings) ? input.confirmedFindings : [],
    rejectedHypotheses: Array.isArray(input.rejectedHypotheses) ? input.rejectedHypotheses : [],
    proposedActions: Array.isArray(input.proposedActions) ? input.proposedActions : [],
    lastActivity: input.lastActivity || null,
    createdAt: input.createdAt || now,
    updatedAt: now,
  };
}

export class InvestigationSessionStore {
  constructor({ persistence } = {}) { this.persistence = persistence || null; this.sessions = new Map(); }

  async create(input) {
    const session = createInvestigationSession(input);
    this.sessions.set(session.id, session);
    await this.persist(session);
    return session;
  }

  async get(id) {
    const key = String(id);
    if (this.sessions.has(key)) return this.sessions.get(key);
    if (this.persistence && typeof this.persistence.load === 'function') {
      const loaded = await this.persistence.load(key);
      if (loaded) { const session = createInvestigationSession(loaded); this.sessions.set(key, session); return session; }
    }
    return null;
  }

  async update(id, patch = {}) {
    const current = await this.get(id);
    if (!current) return null;
    const allowed = ['binaryId','binaryIdentity','projectId','mode','style','scope','effectiveScope','goal','messages','summary','investigationMemory','pinnedEvidence','hypotheses','confirmedFindings','rejectedHypotheses','proposedActions','lastActivity'];
    for (const key of allowed) if (Object.prototype.hasOwnProperty.call(patch, key)) current[key] = key === 'investigationMemory' ? createInvestigationMemory(patch[key]) : patch[key];
    // Identity upgrades must update both representations atomically. Otherwise
    // a legacy/weak session can accept a strong hash on this turn but be
    // rejected on the next turn because binaryId still contains filename:slice.
    if (!Object.prototype.hasOwnProperty.call(patch, 'binaryId') && patch.binaryIdentity?.id) current.binaryId = String(patch.binaryIdentity.id);
    if (current.binaryId != null) current.binaryId = String(current.binaryId);
    current.updatedAt = new Date().toISOString();
    await this.persist(current);
    return current;
  }

  async updateMemory(id, patch = {}) {
    const current = await this.get(id);
    if (!current) return null;
    const next = { ...current.investigationMemory };
    for (const key of MEMORY_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      next[key] = ['goal','anchor'].includes(key) ? patch[key] : mergeUnique(next[key], patch[key], key);
    }
    return this.update(id, { investigationMemory: next });
  }

  async appendMessage(id, message) {
    const current = await this.get(id);
    if (!current) return null;
    current.messages.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: String(message.content || '').slice(0, 20000), timestamp: message.timestamp || new Date().toISOString() });
    current.messages = current.messages.slice(-100);
    return this.update(id, { messages: current.messages });
  }

  async persist(session) { if (this.persistence && typeof this.persistence.save === 'function') await this.persistence.save(stripSecrets(session)); }
  list(binaryId = null) { return Array.from(this.sessions.values()).filter((session) => binaryId == null || session.binaryId === String(binaryId)); }
}

export function stripSecrets(value) {
  const blocked = /api.?key|token|secret|authorization|credential/i;
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) if (!blocked.test(key)) out[key] = stripSecrets(item);
  return out;
}

export function createProjectSessionPersistence(project, { onChange } = {}) {
  if (!project || typeof project !== 'object') throw new Error('project-required');
  project.findings ||= {}; project.findings.investigationSessions ||= [];
  return {
    async load(id) { return project.findings.investigationSessions.find((session) => session && session.id === String(id)) || null; },
    async save(session) {
      const safe = stripSecrets(session);
      const index = project.findings.investigationSessions.findIndex((item) => item && item.id === safe.id);
      if (index >= 0) project.findings.investigationSessions[index] = safe; else project.findings.investigationSessions.push(safe);
      project.updatedAt = new Date().toISOString();
      if (typeof onChange === 'function') onChange(project, safe);
    },
  };
}

function bounded(value, limit) { return Array.isArray(value) ? value.slice(-limit) : []; }
function mergeUnique(current, incoming, key) {
  const values = [...bounded(current, 100), ...bounded(incoming, 100)];
  const seen = new Set();
  return values.filter((item) => {
    const id = typeof item === 'string' ? item : String(item?.id ?? item?.claim ?? item?.summary ?? JSON.stringify(item));
    if (seen.has(id)) return false; seen.add(id); return true;
  }).slice(-64);
}
