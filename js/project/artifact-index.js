export const PROJECT_ARTIFACT_REF_VERSION = 1;
export const PROJECT_ARTIFACT_INDEX_VERSION = 'hex-project-artifact-index-v1';

function required(value, code) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(code);
  return text;
}

export function createArtifactRef(input = {}) {
  return Object.freeze({
    version:PROJECT_ARTIFACT_REF_VERSION,
    scope:required(input.scope, 'artifact-ref-scope-required'),
    kind:required(input.kind, 'artifact-ref-kind-required'),
    artifactId:required(input.artifactId, 'artifact-ref-id-required'),
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
  constructor(refs = []) {
    this.refs = new Map();
    for (const ref of refs) this.bind(ref);
  }

  static key(scope, kind) { return `${String(scope)}\u0000${String(kind)}`; }

  bind(input) {
    const ref = isArtifactRef(input) ? Object.freeze({ ...input }) : createArtifactRef(input);
    this.refs.set(ProjectArtifactIndex.key(ref.scope, ref.kind), ref);
    return ref;
  }

  unbind(scope, kind) { return this.refs.delete(ProjectArtifactIndex.key(scope, kind)); }
  get(scope, kind) { return this.refs.get(ProjectArtifactIndex.key(scope, kind)) || null; }

  list() {
    return Object.freeze([...this.refs.values()].sort((a, b) => a.scope.localeCompare(b.scope) || a.kind.localeCompare(b.kind) || a.artifactId.localeCompare(b.artifactId)));
  }

  async resolve(scope, kind, store, options = {}) {
    const ref = this.get(scope, kind);
    if (!ref) return { status:'miss', reason:'no-ref', ref:null };
    const result = await store.get(ref.artifactId, options);
    if (result.status !== 'hit') return { status:'miss', reason:result.reason || result.status, ref, storeResult:result };
    return { status:'hit', ref, artifact:result };
  }

  toProjectReferences() { return this.list().map((ref) => ({ ...ref })); }
}

export function artifactIndexFromProject(project) {
  const refs = Array.isArray(project?.analysis?.cacheReferences)
    ? project.analysis.cacheReferences.filter(isArtifactRef)
    : [];
  return new ProjectArtifactIndex(refs);
}
