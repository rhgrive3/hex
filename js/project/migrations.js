export class ProjectMigrationError extends Error {
  constructor(message, { code = "HEX_PROJECT_MIGRATION_ERROR", fromVersion = null, toVersion = null } = {}) {
    super(message);
    this.name = "ProjectMigrationError";
    this.code = code;
    this.fromVersion = fromVersion;
    this.toVersion = toVersion;
  }
}

export const PROJECT_MIGRATIONS = Object.freeze({});

export function migrateHexProject(raw, {
  currentVersion,
  migrations = PROJECT_MIGRATIONS,
} = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const rawVersion = raw.version;
  if (!Number.isInteger(rawVersion) || rawVersion < 1) return raw;
  if (rawVersion > currentVersion) {
    throw new ProjectMigrationError(
      `project version ${rawVersion} is newer than supported version ${currentVersion}`,
      { code: "HEX_PROJECT_FUTURE_VERSION", fromVersion: rawVersion, toVersion: currentVersion }
    );
  }
  let working = raw;
  let version = rawVersion;
  while (version < currentVersion) {
    const migration = migrations[version];
    if (typeof migration !== "function") {
      throw new ProjectMigrationError(
        `missing project migration ${version} -> ${version + 1}`,
        { code: "HEX_PROJECT_MIGRATION_MISSING", fromVersion: version, toVersion: version + 1 }
      );
    }
    const next = migration(working);
    if (!next || typeof next !== "object" || Array.isArray(next) || next.version !== version + 1) {
      throw new ProjectMigrationError(
        `invalid project migration result for ${version} -> ${version + 1}`,
        { code: "HEX_PROJECT_MIGRATION_INVALID", fromVersion: version, toVersion: version + 1 }
      );
    }
    working = next;
    version = next.version;
  }
  return working;
}
