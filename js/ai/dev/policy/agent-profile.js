export const AGENT_PROFILE = Object.freeze({ STANDARD: 'standard', DEV: 'dev' });
export const AGENT_PROFILES = Object.freeze(Object.values(AGENT_PROFILE));

export function assertAgentProfile(value) {
  const profile = String(value || '').toLowerCase();
  if (!AGENT_PROFILES.includes(profile)) throw new TypeError(`Unsupported agent profile: ${value}`);
  return profile;
}

export function availableAgentProfiles(identity = {}) {
  return Object.freeze(identity.admin === true
    ? [AGENT_PROFILE.STANDARD, AGENT_PROFILE.DEV]
    : [AGENT_PROFILE.STANDARD]);
}

export function canSelectAgentProfile(identity, profile) {
  const normalized = assertAgentProfile(profile);
  return normalized === AGENT_PROFILE.STANDARD || identity?.admin === true;
}
