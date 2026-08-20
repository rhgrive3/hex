export const AI_QUOTA = Object.freeze({
  windowMs: 60_000,
  ipRateLimit: 30,
  sessionRateLimit: 30,
  ipConcurrencyLimit: 4,
  sessionConcurrencyLimit: 2,
  leaseMs: 120_000,
});

const MAX_SESSION_ID = 128;

export function normalizeQuotaSessionId(value) {
  const text = String(value == null ? '' : value).trim().slice(0, MAX_SESSION_ID);
  return text || 'anonymous';
}

function finiteInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

function normalizedSession(raw, windowStarted) {
  if (!raw || Number(raw.windowStarted) !== windowStarted) return { windowStarted, count: 0 };
  return { windowStarted, count: finiteInt(raw.count) };
}

export function normalizeQuotaState(raw, now = Date.now(), config = AI_QUOTA) {
  const t = finiteInt(now);
  const windowMs = finiteInt(config.windowMs, AI_QUOTA.windowMs) || AI_QUOTA.windowMs;
  let windowStarted = finiteInt(raw?.windowStarted, t);
  let count = finiteInt(raw?.count);
  let sessions = raw?.sessions && typeof raw.sessions === 'object' ? { ...raw.sessions } : {};
  if (t < windowStarted || t - windowStarted >= windowMs) {
    windowStarted = t;
    count = 0;
    sessions = {};
  }

  const leases = {};
  if (raw?.leases && typeof raw.leases === 'object') {
    for (const [token, lease] of Object.entries(raw.leases)) {
      const expiresAt = finiteInt(lease?.expiresAt);
      if (!token || expiresAt <= t) continue;
      leases[token] = {
        sessionId: normalizeQuotaSessionId(lease?.sessionId),
        expiresAt,
      };
    }
  }
  return { windowStarted, count, sessions, leases };
}

function activeForSession(leases, sessionId) {
  let n = 0;
  for (const lease of Object.values(leases || {})) if (lease.sessionId === sessionId) n++;
  return n;
}

function firstLeaseExpiry(leases, sessionId = null) {
  let min = null;
  for (const lease of Object.values(leases || {})) {
    if (sessionId != null && lease.sessionId !== sessionId) continue;
    if (min == null || lease.expiresAt < min) min = lease.expiresAt;
  }
  return min;
}

export function acquireQuotaState(raw, request = {}, config = AI_QUOTA) {
  const now = finiteInt(request.now, Date.now());
  const state = normalizeQuotaState(raw, now, config);
  const sessionId = normalizeQuotaSessionId(request.sessionId);
  const session = normalizedSession(state.sessions[sessionId], state.windowStarted);
  const ipRateLimit = finiteInt(config.ipRateLimit, AI_QUOTA.ipRateLimit);
  const sessionRateLimit = finiteInt(config.sessionRateLimit, AI_QUOTA.sessionRateLimit);
  const ipConcurrencyLimit = finiteInt(config.ipConcurrencyLimit, AI_QUOTA.ipConcurrencyLimit);
  const sessionConcurrencyLimit = finiteInt(config.sessionConcurrencyLimit, AI_QUOTA.sessionConcurrencyLimit);
  const leaseMs = finiteInt(config.leaseMs, AI_QUOTA.leaseMs) || AI_QUOTA.leaseMs;
  const active = Object.keys(state.leases).length;
  const sessionActive = activeForSession(state.leases, sessionId);

  if (state.count >= ipRateLimit || session.count >= sessionRateLimit) {
    const retryAfterMs = Math.max(1, state.windowStarted + config.windowMs - now);
    return { state, result: { allowed: false, reason: 'rate', retryAfterMs, active, sessionActive } };
  }
  if (active >= ipConcurrencyLimit || sessionActive >= sessionConcurrencyLimit) {
    const expiry = active >= ipConcurrencyLimit
      ? firstLeaseExpiry(state.leases)
      : firstLeaseExpiry(state.leases, sessionId);
    return {
      state,
      result: {
        allowed: false,
        reason: 'concurrency',
        retryAfterMs: Math.max(1, (expiry ?? (now + leaseMs)) - now),
        active,
        sessionActive,
      },
    };
  }

  const token = String(request.token || '').trim();
  if (!token) throw new TypeError('quota acquisition requires a lease token');
  const existingLease = state.leases[token];
  if (existingLease) {
    return {
      state,
      result: {
        allowed: false,
        reason: 'concurrency',
        retryAfterMs: Math.max(1, existingLease.expiresAt - now),
        active,
        sessionActive,
      },
    };
  }
  state.count++;
  session.count++;
  state.sessions[sessionId] = session;
  state.leases[token] = { sessionId, expiresAt: now + leaseMs };
  return {
    state,
    result: {
      allowed: true,
      token,
      retryAfterMs: 0,
      remaining: Math.max(0, ipRateLimit - state.count),
      active: active + 1,
      sessionActive: sessionActive + 1,
    },
  };
}

export function releaseQuotaState(raw, token, now = Date.now(), config = AI_QUOTA) {
  const state = normalizeQuotaState(raw, now, config);
  const key = String(token || '').trim();
  const released = !!(key && state.leases[key]);
  if (released) delete state.leases[key];
  return { state, released };
}
