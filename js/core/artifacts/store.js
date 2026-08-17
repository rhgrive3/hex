import {
  ARTIFACT_STORE_VERSION,
  ArtifactCorruptionError,
  createArtifactRecord,
  decodeArtifactPayload,
  encodeArtifactPayload,
  validateArtifactRecord,
} from './contracts.js';
import { ArtifactHotCache } from './hot-cache.js';
import { createArtifactBackend } from './backends.js';

const INCOMPATIBLE_CODES = new Set([
  'artifact-record-schema-mismatch',
  'artifact-contract-version-mismatch',
  'artifact-payload-encoding-unsupported',
  'artifact-producer-version-mismatch',
  'artifact-semantic-schema-mismatch',
  'artifact-id-mismatch',
]);

function aborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason || new DOMException('Aborted', 'AbortError');
}

export class ArtifactStore {
  constructor({ backend = createArtifactBackend(), hotCache = new ArtifactHotCache(), corruptionPolicy = 'delete' } = {}) {
    this.backend = backend;
    this.hotCache = hotCache;
    this.corruptionPolicy = corruptionPolicy;
    this.metrics = {
      requests:0, hotHits:0, persistentHits:0, misses:0, corruptions:0, incompatibilities:0,
      publishes:0, publishBytes:0, partialPublishFailures:0, staleDependencyMisses:0,
    };
  }

  capabilities() {
    return Object.freeze({ storeVersion:ARTIFACT_STORE_VERSION, ...this.backend.capabilities() });
  }

  async get(descriptorOrId, options = {}) {
    const descriptor = typeof descriptorOrId === 'string' ? null : descriptorOrId;
    const artifactId = String(descriptor?.artifactId ?? descriptorOrId ?? '');
    if (!artifactId) throw new TypeError('artifact-id-required');
    aborted(options.signal);
    this.metrics.requests++;

    const cached = this.hotCache.get(artifactId);
    if (cached) {
      try {
        validateArtifactRecord(cached.record, cached.payloadBytes, {
          artifactId,
          producerVersion:descriptor?.producerVersion,
          semanticSchemaVersion:descriptor?.versions?.semanticSchema,
          allowIncomplete:options.allowIncomplete,
        });
        if (!(await this.#upstreamsValid(cached.record, options))) return this.#staleDependency(artifactId, 'hot');
        this.metrics.hotHits++;
        return { status:'hit', source:'hot', artifactId, record:cached.record, payload:cached.payload };
      } catch (error) {
        this.hotCache.delete(artifactId);
        if (error instanceof ArtifactCorruptionError) return this.#invalidResult(artifactId, error, 'hot');
        throw error;
      }
    }

    const raw = await this.backend.getRaw(artifactId);
    aborted(options.signal);
    if (!raw) {
      this.metrics.misses++;
      return { status:'miss', source:'persistent', artifactId, reason:'not-found' };
    }

    try {
      validateArtifactRecord(raw.record, raw.payload, {
        artifactId,
        producerVersion:descriptor?.producerVersion,
        semanticSchemaVersion:descriptor?.versions?.semanticSchema,
        allowIncomplete:options.allowIncomplete,
      });
      if (!(await this.#upstreamsValid(raw.record, options))) return this.#staleDependency(artifactId, 'persistent');
      const payload = decodeArtifactPayload(raw.payload);
      const value = { record:raw.record, payloadBytes:raw.payload, payload };
      this.hotCache.put(artifactId, value, raw.payload.byteLength);
      this.metrics.persistentHits++;
      return { status:'hit', source:'persistent', artifactId, record:raw.record, payload };
    } catch (error) {
      if (error instanceof ArtifactCorruptionError) return this.#invalidResult(artifactId, error, 'persistent');
      throw error;
    }
  }

  async #upstreamsValid(record, options) {
    if (options.verifyUpstreams === false) return true;
    for (const upstreamId of record.upstreamArtifactIds || []) {
      aborted(options.signal);
      if (!(await this.backend.has(upstreamId))) return false;
    }
    return true;
  }

  async #staleDependency(artifactId, source) {
    this.metrics.staleDependencyMisses++;
    this.metrics.misses++;
    this.hotCache.delete(artifactId);
    if (this.corruptionPolicy === 'delete') await this.backend.delete(artifactId);
    return { status:'miss', source, artifactId, reason:'missing-upstream' };
  }

  async #invalidResult(artifactId, error, source) {
    const incompatible = INCOMPATIBLE_CODES.has(error.code);
    if (incompatible) this.metrics.incompatibilities++;
    else this.metrics.corruptions++;
    this.hotCache.delete(artifactId);
    if (this.corruptionPolicy === 'delete') await this.backend.delete(artifactId);
    return {
      status:incompatible ? 'incompatible' : 'corrupt',
      source,
      artifactId,
      reason:error.code,
      error,
    };
  }

  async publish(descriptor, payload, options = {}) {
    if (!descriptor?.artifactId) throw new TypeError('artifact-descriptor-required');
    aborted(options.signal);
    const payloadBytes = encodeArtifactPayload(payload);
    const record = createArtifactRecord(descriptor, payloadBytes, {
      completeness:options.completeness ?? 'complete',
      creation:options.creation,
    });
    if (typeof options.validate === 'function') await options.validate(payload, record, { signal:options.signal });
    aborted(options.signal);

    // Payload and metadata are staged in-memory and become visible through one
    // backend transaction. A backend is not allowed to expose either half alone.
    try {
      await this.backend.putAtomic(record, payloadBytes, { signal:options.signal });
      aborted(options.signal);
    } catch (error) {
      this.hotCache.delete(descriptor.artifactId);
      if (options.signal?.aborted || error?.name === 'AbortError') {
        // Defensive cleanup covers backends where abort raced transaction commit.
        try { await this.backend.delete(descriptor.artifactId); } catch { /* original cancellation wins */ }
        throw error;
      }
      throw error;
    }

    const cached = { record, payloadBytes, payload };
    this.hotCache.put(descriptor.artifactId, cached, payloadBytes.byteLength);
    this.metrics.publishes++;
    this.metrics.publishBytes += payloadBytes.byteLength;
    return { status:'published', artifactId:descriptor.artifactId, record, payload };
  }

  async delete(artifactId) {
    this.hotCache.delete(artifactId);
    return this.backend.delete(artifactId);
  }

  evictHot(artifactId = null) {
    if (artifactId == null) { this.hotCache.clear(); return; }
    this.hotCache.delete(artifactId, true);
  }

  async close() {
    this.hotCache.clear();
    await this.backend.close();
  }

  stats() {
    return Object.freeze({
      storeVersion:ARTIFACT_STORE_VERSION,
      capabilities:this.capabilities(),
      hotCache:this.hotCache.stats(),
      backend:this.backend.stats?.() ?? {},
      ...this.metrics,
    });
  }
}

export function createArtifactStore(options = {}) {
  const backend = options.backend ?? createArtifactBackend(options);
  const hotCache = options.hotCache ?? new ArtifactHotCache(options.hotCacheOptions);
  return new ArtifactStore({ backend, hotCache, corruptionPolicy:options.corruptionPolicy });
}
