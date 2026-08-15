export const HEX_PROJECT_VERSION = 1;
export const HEX_PROJECT_MIME = 'application/vnd.hex.project+json';
export const MAX_PROJECT_BYTES = 16 * 1024 * 1024;
const MAX_COLLECTION_ITEMS = 1_000_000;

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
  return value;
};

function encodedByteLength(text) { return new TextEncoder().encode(text).byteLength; }
function assertProjectSize(bytes) {
  if (bytes > MAX_PROJECT_BYTES) throw new ProjectFormatError('project exceeds the 16 MiB safety limit', 'HEX_PROJECT_TOO_LARGE');
}

export function createHexProject(input = {}) {
  const now = new Date().toISOString();
  return {
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
}

export function normalizeNavigation(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProjectFormatError('navigation must be an object');
  return { currentFunction: value.currentFunction ?? null, history: list(value.history, 'navigation.history').slice(-500), bookmarks: list(value.bookmarks, 'navigation.bookmarks'), lastQuery: value.lastQuery ?? null };
}

export function serializeHexProject(project) {
  const normalized = validateHexProject(project);
  const text = JSON.stringify(normalized, (_key, value) => typeof value === 'bigint' ? { $hexBigInt: value.toString(16) } : value, 2);
  assertProjectSize(encodedByteLength(text));
  return text;
}

export function parseHexProject(input) {
  let text;
  if (typeof input === 'string') text = input;
  else if (input instanceof Uint8Array) { assertProjectSize(input.byteLength); text = new TextDecoder().decode(input); }
  else if (input instanceof ArrayBuffer) { assertProjectSize(input.byteLength); text = new TextDecoder().decode(new Uint8Array(input)); }
  else throw new ProjectFormatError('project input must be JSON text or bytes');
  assertProjectSize(encodedByteLength(text));
  let raw;
  try {
    raw = JSON.parse(text, (_key, value) => {
      if (value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.$hexBigInt === 'string') {
        const encoded = value.$hexBigInt;
        if (!/^-?[0-9a-f]+$/i.test(encoded) || encoded === '-') throw new ProjectFormatError('invalid bigint encoding');
        const negative = encoded.startsWith('-'); const magnitude = negative ? encoded.slice(1) : encoded;
        const parsed = BigInt('0x' + magnitude); return negative ? -parsed : parsed;
      }
      return value;
    });
  } catch (error) {
    if (error instanceof ProjectFormatError) throw error;
    throw new ProjectFormatError(`project JSON is malformed: ${error.message}`);
  }
  return validateHexProject(migrateProject(raw));
}

export function tryParseHexProject(input) { try { return { ok: true, project: parseHexProject(input) }; } catch (error) { return { ok: false, error: error?.message || String(error), code: error?.code || 'HEX_PROJECT_INVALID' }; } }
export function exportHexProject(project, name = 'analysis.hexproj') { const text = serializeHexProject(project); if (typeof File !== 'undefined') return new File([text], name, { type: HEX_PROJECT_MIME }); if (typeof Blob !== 'undefined') return new Blob([text], { type: HEX_PROJECT_MIME }); return new TextEncoder().encode(text); }
export async function importHexProject(input) {
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    assertProjectSize(input.size);
    return parseHexProject(await input.text());
  }
  return parseHexProject(input);
}

export function validateHexProject(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) throw new ProjectFormatError('project root must be an object');
  if (project.format !== 'hexproj') throw new ProjectFormatError('not a .hexproj document');
  if (!Number.isInteger(project.version) || project.version < 1) throw new ProjectFormatError('invalid project version');
  if (project.version > HEX_PROJECT_VERSION) throw new ProjectFormatError(`project version ${project.version} is newer than supported version ${HEX_PROJECT_VERSION}`, 'HEX_PROJECT_FUTURE_VERSION');
  if (!project.binary || typeof project.binary !== 'object' || Array.isArray(project.binary)) throw new ProjectFormatError('project binary metadata is missing');
  if (project.binary.embedded) throw new ProjectFormatError('embedded binaries are not accepted by this project version');

  project.binary.hash ??= null;
  project.binary.metadata ??= null;
  project.binary.embedded = false;
  project.user = project.user && typeof project.user === 'object' && !Array.isArray(project.user) ? project.user : {};
  project.findings = project.findings && typeof project.findings === 'object' && !Array.isArray(project.findings) ? project.findings : {};
  project.analysis = project.analysis && typeof project.analysis === 'object' && !Array.isArray(project.analysis) ? project.analysis : {};

  project.user.names = list(project.user.names, 'user.names');
  project.user.comments = list(project.user.comments, 'user.comments');
  project.user.types = list(project.user.types, 'user.types');
  project.user.structs = list(project.user.structs, 'user.structs');
  project.user.bookmarks = list(project.user.bookmarks, 'user.bookmarks');
  project.user.patches = list(project.user.patches, 'user.patches');
  project.findings.confirmed = list(project.findings.confirmed, 'findings.confirmed');
  project.findings.agentAnswers = list(project.findings.agentAnswers, 'findings.agentAnswers');
  project.findings.evidence = list(project.findings.evidence, 'findings.evidence');
  project.findings.investigationSessions = list(project.findings.investigationSessions, 'findings.investigationSessions');
  project.analysis.settings = project.analysis.settings && typeof project.analysis.settings === 'object' && !Array.isArray(project.analysis.settings) ? project.analysis.settings : {};
  project.analysis.cacheReferences = list(project.analysis.cacheReferences, 'analysis.cacheReferences');
  project.navigation = normalizeNavigation(project.navigation || {});
  project.createdAt ||= new Date(0).toISOString();
  project.updatedAt ||= project.createdAt;
  return project;
}

function migrateProject(raw) { if (!raw || typeof raw !== 'object') return raw; return raw; }
