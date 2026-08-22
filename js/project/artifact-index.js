export const PROJECT_ARTIFACT_REF_VERSION = 1;
export const PROJECT_ARTIFACT_INDEX_VERSION = 'hex-project-artifact-index-v1';
export const MAX_PROJECT_ARTIFACT_REFS = 50_000;

function required(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(code);
  return text;
}

function artifactId(value, missingCode = 'artifact-ref-id-required') {
  const text = required(value, missingCode);
  if (!text.startsWith('artifact_')) throw new TypeError('artifact-ref-id-invalid');
  return text;
}

function normalizeMaxEntries(value = MAX_PROJECT_ARTIFACT_REFS) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_PROJECT_ARTIFACT_REFS) {
    throw new RangeError('artifact-index-max-entries-invalid');
  }
  return number;
}

function expectedArtifactId(options = {}) {
  const value = options.expectedArtifactId ?? options.expectedRef?.artifactId ?? null;
  return value == null ? null : artifactId(value, 'artifact-ref-expected-id-required');
}

function portableStoreError(error) {
  return Object.freeze({
    name:String(error?.name || 'Error'),
    code:error?.code == null ? null : String(error.code),
    message:String(error?.message || error || 'local artifact store unavailable'),
  });
}

export function createArtifactRef(input = {}) {
  return Object.freeze({
    version:PROJECT_ARTIFACT_REF_VERSION,
    scope:required(input.scope, 'artifact-ref-scope-required'),
    kind:required(input.kind, 'artifact-ref-kind-required'),
    artifactId:artifactId(input.artifactId),
  });
}

export function isArtifactRef(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && value.version === PROJECT_ARTIFACT_REF_VERSION
    && typeof value.scope === 'string' && value.scope.length > 0
    && typeof value.kind === 'string' && value.kind.length > 0
    && typeof value.artifactId === 'string' && value.artifactId.startsWith('artifact_')
    && !Object.hasOwn(value, 'payload') && !Object.hasOwn(value, 'record');
}

export class ProjectArtifactIndex {
  constructor(refs = [], options = {}) {
    this.maxEntries = normalizeMaxEntries(options.maxEntries);
    this.refs = new Map();
    this.metrics = { binds:0, replacements:0, evictions:0, invalidations:0 };
    for (const ref of refs) this.bind(ref);
  }

  static key(scope, kind) { return JSON.stringify([String(scope), String(kind)]); }

  get size() { return this.refs.size; }

  bind(input) {
    // Always reconstruct the portable v1 ref. This deliberately strips any
    // caller-owned metadata/graphs so the project index never becomes an
    // accidental ArtifactStore or analysis payload container.
    const ref = createArtifactRef(input);
    const key = ProjectArtifactIndex.key(ref.scope, ref.kind);
    const replacing = this.refs.has(key);
    if (replacing) {
      this.refs.delete(key);
      this.metrics.replacements++;
    }
    this.refs.set(key, ref);
    this.metrics.binds++;

    if (!replacing && this.refs.size > this.maxEntries) {
      const oldestKey = this.refs.keys().next().value;
      this.refs.delete(oldestKey);
      this.metrics.evictions++;
    }
    return ref;
  }

  unbind(scope, kind) { return this.refs.delete(ProjectArtifactIndex.key(scope, kind)); }
  get(scope, kind) { return this.refs.get(ProjectArtifactIndex.key(scope, kind)) || null; }
  has(scope, kind) { return this.refs.has(ProjectArtifactIndex.key(scope, kind)); }

  isCurrent(scope, kind, expectedArtifactIdValue) {
    const ref = this.get(scope, kind);
    return !!ref && ref.artifactId === artifactId(expectedArtifactIdValue, 'artifact-ref-expected-id-required');
  }

  invalidateStale(scope, kind, expectedArtifactIdValue) {
    const ref = this.get(scope, kind);
    if (!ref) return Object.freeze({ status:'miss', reason:'no-ref', ref:null });
    const expected = artifactId(expectedArtifactIdValue, 'artifact-ref-expected-id-required');
    if (ref.artifactId === expected) return Object.freeze({ status:'kept', reason:'current', ref });
    this.refs.delete(ProjectArtifactIndex.key(scope, kind));
    this.metrics.invalidations++;
    return Object.freeze({ status:'invalidated', reason:'artifact-id-changed', ref, expectedArtifactId:expected });
  }

  list() {
    return Object.freeze([...this.refs.values()].sort((a, b) => a.scope.localeCompare(b.scope) || a.kind.localeCompare(b.kind) || a.artifactId.localeCompare(b.artifactId)));
  }

  async resolve(scope, kind, store, options = {}) {
    const ref = this.get(scope, kind);
    if (!ref) return { status:'miss', reason:'no-ref', ref:null };

    const expected = expectedArtifactId(options);
    if (expected != null && ref.artifactId !== expected) {
      if (options.invalidateStaleRef === true) this.invalidateStale(scope, kind, expected);
      return { status:'miss', reason:'stale-ref', ref, expectedArtifactId:expected };
    }

    // Local derived state is optional. A portable project remains usable when
    // there is no local store, the store was deleted, or the backend cannot be
    // opened in the current browser.
    if (!store || typeof store.get !== 'function') {
      return { status:'miss', reason:'store-unavailable', ref };
    }

    let result;
    try {
      result = await store.get(ref.artifactId, options);
    } catch (error) {
      if (options.signal?.aborted || error?.name === 'AbortError') throw error;
      return { status:'miss', reason:'store-unavailable', ref, storeError:portableStoreError(error) };
    }
    if (result?.status !== 'hit') {
      return { status:'miss', reason:result?.reason || result?.status || 'not-found', ref, storeResult:result ?? null };
    }
    return { status:'hit', ref, artifact:result };
  }

  toProjectReferences() {
    // Re-sanitize at the persistence boundary as defense in depth. Even if a
    // caller mutates the public Map directly, no payload/record/graph can be
    // serialized through this API.
    return Object.freeze(this.list().map((ref) => createArtifactRef(ref)));
  }

  stats() {
    return Object.freeze({
      version:PROJECT_ARTIFACT_INDEX_VERSION,
      size:this.refs.size,
      maxEntries:this.maxEntries,
      ...this.metrics,
    });
  }
}

export function artifactIndexFromProject(project, options = {}) {
  const maxEntries = normalizeMaxEntries(options.maxEntries);
  const source = Array.isArray(project?.analysis?.cacheReferences) ? project.analysis.cacheReferences : [];

  // Prefer the newest project refs while bounding both retained references and
  // duplicate-key bookkeeping. Import never copies the whole project list.
  const selected = [];
  const seenKeys = new Set();
  for (let i = source.length - 1; i >= 0 && selected.length < maxEntries; i--) {
    const candidate = source[i];
    if (!isArtifactRef(candidate)) continue;
    const key = ProjectArtifactIndex.key(candidate.scope, candidate.kind);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    selected.push(candidate);
  }
  selected.reverse();
  return new ProjectArtifactIndex(selected, { maxEntries });
}
