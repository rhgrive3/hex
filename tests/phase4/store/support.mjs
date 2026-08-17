import {
  ArtifactStorageError,
  MemoryArtifactBackend,
  createArtifactDescriptor,
} from '../../../js/core/artifacts/index.js';

export function descriptor(id = 'base', overrides = {}) {
  return createArtifactDescriptor({
    binaryId:'bin_p4_1_store',
    entityId:`entity_${id}`,
    artifactKind:'p4-1-store-test',
    producerId:'p4-1-test-producer',
    producerVersion:'1',
    versions:{ loader:'fixture-loader-v1' },
    relevance:{ architectureSemantic:false, abiSemantic:false, semanticSchema:false },
    config:{ id },
    ...overrides,
  });
}

export class PersistentMemoryBackend extends MemoryArtifactBackend {
  capabilities() {
    return Object.freeze({ backend:'test-persistent-memory', persistent:true, indexedDB:false, opfs:false, reason:'test-double' });
  }
}

export class FailingBackend extends MemoryArtifactBackend {
  constructor(error = new ArtifactStorageError('artifact-storage-failure', 'fixture storage failure')) {
    super();
    this.error = error;
  }
  async putAtomic() { throw this.error; }
}

export class AbortOnCommitBackend extends PersistentMemoryBackend {
  constructor(controller, options = {}) { super(options); this.controller = controller; }
  async putAtomic(record, payload, options = {}) {
    const result = await super.putAtomic(record, payload, options);
    this.controller.abort(new DOMException('cancelled at publication boundary', 'AbortError'));
    return result;
  }
}

export class DelayedReadBackend extends PersistentMemoryBackend {
  constructor(options) {
    super(options);
    this.delayNext = false;
    this.entered = null;
    this.release = null;
  }
  armDelay() {
    this.delayNext = true;
    let enterResolve;
    let releaseResolve;
    this.entered = new Promise((resolve) => { enterResolve = resolve; });
    this.release = new Promise((resolve) => { releaseResolve = resolve; });
    this.enterResolve = enterResolve;
    this.releaseResolve = releaseResolve;
  }
  async getRaw(id) {
    const raw = await super.getRaw(id);
    if (this.delayNext) {
      this.delayNext = false;
      this.enterResolve();
      await this.release;
    }
    return raw;
  }
}
