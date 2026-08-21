export const HOST_API_VERSION = "2.0.0";
export const ANALYZER_CONTRACT_VERSION = "1.0.0";

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,127}$/i;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ALLOWED_PERMISSIONS = new Set(["binaryRead"]);
const ALLOWED_ANALYZER_CAPABILITIES = new Set(["cancel", "progress", "binaryRead"]);

export class PluginCompatibilityError extends Error {
  constructor({ code, pluginId, requested, supported, contributionId = null, message = null }) {
    super(message || `Plugin compatibility error: ${code} for ${pluginId} (requested: ${requested}, supported: ${supported})`);
    this.name = "PluginCompatibilityError";
    this.code = code;
    this.pluginId = pluginId;
    this.requested = requested;
    this.supported = supported;
    this.contributionId = contributionId;
  }
}

export function parseSemver(value) {
  if (typeof value !== "string") throw new TypeError("semver-invalid");
  const match = SEMVER_RE.exec(value.trim());
  if (!match) throw new TypeError("semver-invalid");
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: value.trim(),
  };
}

export function isSemverCompatible(requestedStr, supportedStr) {
  const req = parseSemver(requestedStr);
  const sup = parseSemver(supportedStr);
  return req.major === sup.major && req.minor <= sup.minor;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (desc && "value" in desc) deepFreeze(desc.value, seen);
  }
  Object.freeze(value);
  return value;
}

export function validatePluginManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new TypeError("plugin-manifest-invalid");
  if (!ID_RE.test(String(manifest.id || ""))) throw new TypeError("plugin-manifest-id-invalid");
  const name = String(manifest.name || "").trim();
  if (!name || name.length > 200) throw new TypeError("plugin-manifest-name-invalid");

  parseSemver(manifest.version);
  parseSemver(manifest.apiVersion);

  let permissions = {};
  if (manifest.permissions != null) {
    if (typeof manifest.permissions !== "object" || Array.isArray(manifest.permissions)) {
      throw new TypeError("plugin-manifest-permissions-invalid");
    }
    for (const key of Object.keys(manifest.permissions)) {
      if (!ALLOWED_PERMISSIONS.has(key)) throw new TypeError(`plugin-manifest-unknown-permission:${key}`);
    }
    permissions = { binaryRead: Boolean(manifest.permissions.binaryRead) };
  }

  if (!Array.isArray(manifest.supportedTargets) || manifest.supportedTargets.length === 0) {
    throw new TypeError("plugin-manifest-supported-targets-invalid");
  }
  const targets = [];
  const targetSet = new Set();
  for (const t of manifest.supportedTargets) {
    const targetStr = String(t || "").trim();
    if (!targetStr || targetSet.has(targetStr)) throw new TypeError("plugin-manifest-supported-targets-invalid");
    targetSet.add(targetStr);
    targets.push(targetStr);
  }

  if (!Array.isArray(manifest.contributions) || manifest.contributions.length === 0) {
    throw new TypeError("plugin-manifest-contributions-invalid");
  }
  const contributions = [];
  const contribSet = new Set();
  for (const c of manifest.contributions) {
    if (!c || typeof c !== "object") throw new TypeError("plugin-manifest-contribution-invalid");
    if (c.type !== "analyzer") throw new TypeError("plugin-manifest-unsupported-contribution-type");
    if (!ID_RE.test(String(c.id || ""))) throw new TypeError("plugin-manifest-contribution-id-invalid");
    if (contribSet.has(c.id)) throw new TypeError("plugin-manifest-duplicate-contribution-id");
    contribSet.add(c.id);

    parseSemver(c.contractVersion);

    let capabilities = [];
    if (c.capabilities != null) {
      if (!Array.isArray(c.capabilities)) throw new TypeError("plugin-manifest-capabilities-invalid");
      const capSet = new Set();
      for (const cap of c.capabilities) {
        const capStr = String(cap || "").trim();
        if (!ALLOWED_ANALYZER_CAPABILITIES.has(capStr) || capSet.has(capStr)) {
          throw new TypeError(`plugin-manifest-unknown-capability:${capStr}`);
        }
        capSet.add(capStr);
        capabilities.push(capStr);
      }
    }

    contributions.push({
      type: "analyzer",
      id: c.id,
      contractVersion: c.contractVersion,
      capabilities,
    });
  }

  const normalized = {
    id: manifest.id,
    name,
    version: manifest.version,
    apiVersion: manifest.apiVersion,
    permissions,
    supportedTargets: targets,
    contributions,
  };

  return deepFreeze(normalized);
}

export function checkManifestCompatibility(manifest) {
  if (!isSemverCompatible(manifest.apiVersion, HOST_API_VERSION)) {
    throw new PluginCompatibilityError({
      code: "plugin-api-version-incompatible",
      pluginId: manifest.id,
      requested: manifest.apiVersion,
      supported: HOST_API_VERSION,
    });
  }
  for (const contrib of manifest.contributions) {
    if (contrib.type === "analyzer") {
      if (!isSemverCompatible(contrib.contractVersion, ANALYZER_CONTRACT_VERSION)) {
        throw new PluginCompatibilityError({
          code: "plugin-contribution-version-incompatible",
          pluginId: manifest.id,
          contributionId: contrib.id,
          requested: contrib.contractVersion,
          supported: ANALYZER_CONTRACT_VERSION,
        });
      }
    }
  }
}
