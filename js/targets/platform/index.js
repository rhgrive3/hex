const PROFILES = new Map();

function canonicalId(value) { return String(value || '').trim().toLowerCase(); }

export class PlatformProfile {
  constructor(definition = {}) {
    const id = canonicalId(definition.id);
    if (!id) throw new TypeError('platform id is required');
    this.id = id;
    this.semanticVersion = String(definition.semanticVersion || '1');
    this.defaultABI = definition.defaultABI || (() => null);
    this.runtimeLibraries = Object.freeze(Array.isArray(definition.runtimeLibraries) ? definition.runtimeLibraries.slice() : []);
    this.syscallFamily = definition.syscallFamily || null;
    this.debugInfoFamilies = Object.freeze(Array.isArray(definition.debugInfoFamilies) ? definition.debugInfoFamilies.slice() : []);
    Object.freeze(this);
  }
}

export function registerPlatformProfile(definition, { replace = false } = {}) {
  const profile = definition instanceof PlatformProfile ? definition : new PlatformProfile(definition);
  if (PROFILES.has(profile.id) && !replace) throw new Error(`platform already registered: ${profile.id}`);
  PROFILES.set(profile.id, profile);
  return profile;
}

export function platformProfile(id) { return PROFILES.get(canonicalId(id)) || PROFILES.get('unknown') || null; }

export const DARWIN_PLATFORM = registerPlatformProfile({
  id:'darwin', semanticVersion:'1', runtimeLibraries:['libSystem','objc','swift'], debugInfoFamilies:['dwarf','dsym'],
  defaultABI:({ architecture }) => architecture === 'arm64' || architecture === 'arm64e' ? 'aapcs64' : null,
});
export const LINUX_PLATFORM = registerPlatformProfile({
  id:'linux', semanticVersion:'1', runtimeLibraries:['glibc'], syscallFamily:'linux', debugInfoFamilies:['dwarf'],
  defaultABI:({ architecture }) => architecture === 'arm64' || architecture === 'arm64e' ? 'aapcs64' : null,
});
export const WINDOWS_PLATFORM = registerPlatformProfile({
  id:'windows', semanticVersion:'1', runtimeLibraries:['ntdll','kernel32'], syscallFamily:'windows-nt', debugInfoFamilies:['codeview','pdb'],
  defaultABI:()=>null,
});
export const UNKNOWN_PLATFORM = registerPlatformProfile({ id:'unknown', semanticVersion:'1', defaultABI:()=>null });
