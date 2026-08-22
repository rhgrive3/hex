import { artifactIndexFromProject, isArtifactRef } from './artifact-index.js';
import {
  migrateHexProject,
  ProjectMigrationError,
  PROJECT_MIGRATIONS,
} from './migrations.js';

export const HEX_PROJECT_VERSION = 1;
export const HEX_PROJECT_MIME = 'application/vnd.hex.project+json';
export const MAX_PROJECT_BYTES = 16 * 1024 * 1024;
const MAX_COLLECTION_ITEMS = 1_000_000;
const MAX_LEGACY_CACHE_REFERENCE_LENGTH = 512;

export class ProjectFormatError extends Error {
  constructor(message, code = 'HEX_PROJECT_INVALID') {
    super(message);
    this.name = 'ProjectFormatError';
    this.code = code;
  }
}

const list = (value, name) => {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new ProjectFormatError(`${name} must be an array`);
  if (value.length > MAX_COLLECTION_ITEMS) throw new ProjectFormatError(`${name} is unreasonably large`);
  return [...value];
};

function encodedByteLength(text) { return new TextEncoder().encode(text).byteLength; }
function assertProjectSize(bytes) {
  if (bytes > MAX_PROJECT_BYTES) throw new ProjectFormatError('project exceeds the 16 MiB safety limit', 'HEX_PROJECT_TOO_LARGE');
}
function isLegacyPortableCacheReference(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_LEGACY_CACHE_REFERENCE_LENGTH;
}
function sanitizeCacheReferences(project) {
  const source = list(project?.analysis?.cacheReferences, 'analysis.cacheReferences');
  const legacy = source.filter(isLegacyPortableCacheReference);
  const structuredProject = {
    ...project,
    analysis: {
      ...(project.analysis || {}),
      cacheReferences: source.filter(isArtifactRef),
    },
  };
  return [...legacy, ...artifactIndexFromProject(structuredProject).toProjectReferences()];
}

export function createHexProject(input = {}) {
  const now = new Date().toISOString();
  const project = {
    format: 'hexproj', version: HEX_PROJECT_VERSION,
    createdAt: input.createdAt || now, updatedAt: now,
    binary: { hash: input.binaryHash || input.binary?.hash || null, metadata: input.binaryMetadata || input.binary?.metadata || null, embedded: false },
    user: {
      names: list(input.userNames ?? input.user?.names, 'user.names'), comments: list(input.comments ?? input.user?.comments, 'user.comments'),
      types: list(input.types ?? input.user?.types, 'user.types'), structs: list(input.structs ?? input.user?.structs, 'user.structs'),
      bookmarks: list(input.bookmarks ?? input.user?.bookmarks, 'user.bookmarks'), patches: list(input.patches ?? input.user?.patches, 'user.patches'),
    },
    findings: {
      confirmed: list(input.confirmedFindings ?? input.findings?.confirmed, 'findings.confirmed'),
      agentAnswers: list(input.agentAnswers ?? input.findings?.agentAnswers, 'findings.agentAnswers'),
      evidence: list(input.evidence ?? input.findings?.evidence, 'findings.evidence'),
      investigationSessions: list(input.investigationSessions ?? input.findings?.investigationSessions, 'findings.investigationSessions'),
    },
    analysis: { settings: input.analysisSettings || input.analysis?.settings || {}, cacheReferences: list(input.cacheReferences ?? input.analysis?.cacheReferences, 'analysis.cacheReferences') },
    navigation: normalizeNavigation(input.navigation || {}),
  };
  project.analysis.cacheReferences = sanitizeCacheReferences(project);
  return project;
}

export function normalizeNavigation(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProjectFormatError('navigation must be an object');
  return { currentFunction: value.currentFunction ?? null, history: list(value.history, 'navigation.history').slice(-500), bookmarks: list(value.bookmarks, 'navigation.bookmarks'), lastQuery: value.lastQuery ?? null };
}

/*
 * `.hexproj` encodes a BigInt as the single-key object `{ $hexBigInt: hex }`.
 * The reader cannot tell that wrapper apart from an ordinary object a user
 * genuinely had, so `{ $hexBigInt: '10' }` came back as `16n` and save+reload
 * silently rewrote their data (#1366).
 *
 * Renaming the tag would only move the collision, so the tag name is reserved
 * instead: on the way out, any object key matching `$hexBigInt` with one or
 * more leading `$` gains one more `$`; on the way in, the reader takes one
 * back. That is injective -- `$hexBigInt` -> `$$hexBigInt` -> `$$$hexBigInt` --
 * so ordinary data and the tag can never occupy the same shape.
 *
 * Files written before this change are unaffected: a real `{ $hexBigInt: hex }`
 * still reads as a BigInt, because escaped keys never produce that exact shape.
 */
const BIGINT_TAG = '$hexBigInt';
const ESCAPED_TAG = /^\$(\$*)\$hexBigInt$/;

function escapeBigIntTag(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const keys = Object.keys(value);
  if (!keys.some((key) => key === BIGINT_TAG || ESCAPED_TAG.test(key))) return value;
  const out = {};
  for (const key of keys) {
    const escaped = key === BIGINT_TAG || ESCAPED_TAG.test(key) ? `$${key}` : key;
    Object.defineProperty(out, escaped, { value: value[key], enumerable: true, configurable: true, writable: true });
  }
  return out;
}

function unescapeBigIntTag(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const keys = Object.keys(value);
  if (!keys.some((key) => ESCAPED_TAG.test(key))) return value;
  const out = {};
  for (const key of keys) {
    const unescaped = ESCAPED_TAG.test(key) ? key.slice(1) : key;
    Object.defineProperty(out, unescaped, { value: value[key], enumerable: true, configurable: true, writable: true });
  }
  return out;
}

export function serializeHexProject(project) {
  const normalized = validateHexProject(project);
  const text = JSON.stringify(normalized, (_key, value) => (
    typeof value === 'bigint' ? { [BIGINT_TAG]: value.toString(16) } : escapeBigIntTag(value)
  ), 2);
  assertProjectSize(encodedByteLength(text));
  return text;
}

/*
 * A `.hexproj` arriving as bytes must be valid UTF-8 or it is not a project.
 * The default `TextDecoder` is non-fatal: it rewrites every invalid byte as
 * U+FFFD, so a corrupted file parsed cleanly as a *different* project whose
 * strings contained characters the original bytes never held (#1388). Failing
 * closed is the only honest answer -- silently substituting characters changes
 * user data without telling anyone.
 */
function decodeProjectBytes(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ProjectFormatError('project bytes are not valid UTF-8');
  }
}

export function parseHexProject(input) {
  let text;
  if (typeof input === 'string') text = input;
  else if (input instanceof Uint8Array) { assertProjectSize(input.byteLength); text = decodeProjectBytes(input); }
  else if (input instanceof ArrayBuffer) { assertProjectSize(input.byteLength); text = decodeProjectBytes(new Uint8Array(input)); }
  else throw new ProjectFormatError('project input must be JSON text or bytes');
  assertProjectSize(encodedByteLength(text));
  let raw;
  try {
    raw = JSON.parse(text, (_key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === 1 && Object.hasOwn(value, BIGINT_TAG) && typeof value[BIGINT_TAG] === 'string') {
        const encoded = value[BIGINT_TAG];
        if (!/^-?[0-9a-f]+$/i.test(encoded) || encoded === '-') throw new ProjectFormatError('invalid bigint encoding');
        const negative = encoded.startsWith('-'); const magnitude = negative ? encoded.slice(1) : encoded;
        const parsed = BigInt('0x' + magnitude); return negative ? -parsed : parsed;
      }
      return unescapeBigIntTag(value);
    });
  } catch (error) {
    if (error instanceof ProjectFormatError) throw error;
    throw new ProjectFormatError(`project JSON is malformed: ${error.message}`);
  }
  let migrated;
  try {
    migrated = migrateHexProject(raw, { currentVersion: HEX_PROJECT_VERSION });
  } catch (error) {
    if (error instanceof ProjectMigrationError) {
      throw new ProjectFormatError(error.message, error.code);
    }
    throw error;
  }
  return normalizeHexProjectV1(migrated);
}

export function tryParseHexProject(input) { try { return { ok: true, project: parseHexProject(input) }; } catch (error) { return { ok: false, error: error?.message || String(error), code: error?.code || 'HEX_PROJECT_INVALID' }; } }
export function exportHexProject(project, name = 'analysis.hexproj') { const text = serializeHexProject(project); if (typeof File !== 'undefined') return new File([text], name, { type: HEX_PROJECT_MIME }); if (typeof Blob !== 'undefined') return new Blob([text], { type: HEX_PROJECT_MIME }); return new TextEncoder().encode(text); }
export async function importHexProject(input) {
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    assertProjectSize(input.size);
    // `Blob.text()` is the same non-fatal decode, so the bytes go through the
    // one strict parser instead of a second, laxer path (#1388).
    return parseHexProject(new Uint8Array(await input.arrayBuffer()));
  }
  return parseHexProject(input);
}

export function normalizeHexProjectV1(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) throw new ProjectFormatError('project root must be an object');
  if (project.format !== 'hexproj') throw new ProjectFormatError('not a .hexproj document');
  if (!Number.isInteger(project.version) || project.version < 1) throw new ProjectFormatError('invalid project version');
  if (project.version > HEX_PROJECT_VERSION) throw new ProjectFormatError(`project version ${project.version} is newer than supported version ${HEX_PROJECT_VERSION}`, 'HEX_PROJECT_FUTURE_VERSION');
  if (!project.binary || typeof project.binary !== 'object' || Array.isArray(project.binary)) throw new ProjectFormatError('project binary metadata is missing');
  if (project.binary.embedded) throw new ProjectFormatError('embedded binaries are not accepted by this project version');

  const createdAt = project.createdAt || new Date(0).toISOString();
  const updatedAt = project.updatedAt || createdAt;

  const normalized = {
    format: 'hexproj',
    version: HEX_PROJECT_VERSION,
    createdAt,
    updatedAt,
    binary: {
      hash: project.binary.hash ?? null,
      metadata: project.binary.metadata ?? null,
      embedded: false,
    },
    user: {
      names: list(project.user?.names, 'user.names'),
      comments: list(project.user?.comments, 'user.comments'),
      types: list(project.user?.types, 'user.types'),
      structs: list(project.user?.structs, 'user.structs'),
      bookmarks: list(project.user?.bookmarks, 'user.bookmarks'),
      patches: list(project.user?.patches, 'user.patches'),
    },
    findings: {
      confirmed: list(project.findings?.confirmed, 'findings.confirmed'),
      agentAnswers: list(project.findings?.agentAnswers, 'findings.agentAnswers'),
      evidence: list(project.findings?.evidence, 'findings.evidence'),
      investigationSessions: list(project.findings?.investigationSessions, 'findings.investigationSessions'),
    },
    analysis: {
      settings: project.analysis?.settings && typeof project.analysis.settings === 'object' && !Array.isArray(project.analysis.settings)
        ? { ...project.analysis.settings }
        : {},
      cacheReferences: list(project.analysis?.cacheReferences, 'analysis.cacheReferences'),
    },
    navigation: normalizeNavigation(project.navigation || {}),
  };

  normalized.analysis.cacheReferences = sanitizeCacheReferences(normalized);
  return normalized;
}

export function validateHexProject(project) {
  return normalizeHexProjectV1(project);
}

export { ProjectMigrationError, migrateHexProject, PROJECT_MIGRATIONS };

