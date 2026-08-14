import { AI_MODES, AI_SCOPES, AI_STYLES } from '../schema.js';

let sessionSequence = 1;

export function createInvestigationSession(input = {}) {
  const now = new Date().toISOString();
  return {
    id: String(input.id || `ai_${Date.now().toString(36)}_${sessionSequence++}`),
    binaryId: input.binaryId == null ? null : String(input.binaryId),
    mode: AI_MODES.includes(input.mode) ? input.mode : 'chat',
    style: AI_STYLES.includes(input.style) ? input.style : 'analyst',
    scope: AI_SCOPES.includes(input.scope) ? input.scope : 'auto',
    goal: String(input.goal || ''),
    messages: Array.isArray(input.messages) ? input.messages.slice(-100) : [],
    summary: String(input.summary || ''),
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
  constructor({ persistence } = {}) {
    this.persistence = persistence || null;
    this.sessions = new Map();
  }

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
    const allowed = ['mode', 'style', 'scope', 'goal', 'messages', 'summary', 'pinnedEvidence', 'hypotheses', 'confirmedFindings', 'rejectedHypotheses', 'proposedActions', 'lastActivity'];
    for (const key of allowed) if (Object.prototype.hasOwnProperty.call(patch, key)) current[key] = patch[key];
    current.updatedAt = new Date().toISOString();
    await this.persist(current);
    return current;
  }

  async appendMessage(id, message) {
    const current = await this.get(id);
    if (!current) return null;
    current.messages.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: String(message.content || '').slice(0, 20000), timestamp: message.timestamp || new Date().toISOString() });
    current.messages = current.messages.slice(-100);
    return this.update(id, { messages: current.messages });
  }

  async persist(session) {
    if (this.persistence && typeof this.persistence.save === 'function') await this.persistence.save(stripSecrets(session));
  }

  list(binaryId = null) {
    return Array.from(this.sessions.values()).filter((session) => binaryId == null || session.binaryId === String(binaryId));
  }
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
  project.findings ||= {};
  project.findings.investigationSessions ||= [];
  return {
    async load(id) {
      return project.findings.investigationSessions.find((session) => session && session.id === String(id)) || null;
    },
    async save(session) {
      const safe = stripSecrets(session);
      const index = project.findings.investigationSessions.findIndex((item) => item && item.id === safe.id);
      if (index >= 0) project.findings.investigationSessions[index] = safe;
      else project.findings.investigationSessions.push(safe);
      project.updatedAt = new Date().toISOString();
      if (typeof onChange === 'function') onChange(project, safe);
    },
  };
}
