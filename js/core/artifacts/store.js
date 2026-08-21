import {
  ARTIFACT_STORE_VERSION,
  ArtifactCorruptionError,
  createArtifactRecord,
  decodeArtifactPayload,
  encodeArtifactPayload,
} from './contracts.js';
import { ArtifactHotCache } from './hot-cache.js';
import { createArtifactBackend } from './backends.js';
import {
  canonicalStoredRecord,
  normalizeStoredPayloadBytes,
  validateStoredArtifact,
} from './storage/integrity.js';

const INCOMPATIBLE_CODES = new Set([
  'artifact-record-schema-mismatch',
  'artifact-contract-version-mismatch',
  'artifact-payload-encoding-unsupported',
  'artifact-producer-version-mismatch',
  'artifact-semantic-schema-mismatch',
  'artifact-id-mismatch',
  'artifact-record-identity-mismatch',
  'artifact-storage-envelope-schema-mismatch',
]);

function aborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason || new DOMException('Aborted', 'AbortError');
}

function isAbort(error, signal) {
  return error?.name === 'AbortError' || !!signal?.aborted;
}

export class ArtifactStore {
  constructor({ backend = createArtifactBackend(), hotCache = new ArtifactHotCache(), corruptionPolicy = 'delete' } = {}) {
    if (!backend?.getRaw || !backend?.putAtomic || !backend?.delete || !backend?.capabilities) throw new TypeError('artifact-backend-invalid');
    if (!hotCache?.get || !hotCache?.put || !hotCache?.delete) throw new TypeError('artifact-hot-cache-invalid');
    if (!['delete', 'retain'].includes(corruptionPolicy)) throw new TypeError('artifact-corruption-policy-invalid');
    this.backend = backend;
    this.hotCache = hotCache;
    this.corruptionPolicy = corruptionPolicy;
    this.mutations = new Map();
    this.epochs = new Map();
    this.metrics = {
      requests:0,
      reads:0,
      hotHits:0,
      persistentHits:0,
      memoryHits:0,
      misses:0,
      readBytes:0,
      corruptions:0,
      incompatibilities:0,
      validationFailures:0,
      serializationFailures:0,
      storageFailures:0,
      publishes:0,
      writes:0,
      duplicatePuts:0,
      publishBytes:0,
      writeBytes:0,
      cancelledPublishes:0,
      staleDependencyMisses:0,
      deletes:0,
      deleteMisses:0,
      mutationRetries:0,
    };
  }

  capabilities() {
    return Object.freeze({ storeVersion:ARTIFACT_STORE_VERSION, ...this.backend.capabilities() });
  }

  #backendSource() {
    return this.capabilities().persistent ? 'persistent' : 'memory';
  }

  #epoch(artifactId) {
    return this.epochs.get(String(artifactId)) || 0;
  }

  #bumpEpoch(artifactId) {
    const id = String(artifactId);
    this.epochs.set(id, this.#epoch(id) + 1);
  }

  async #waitForMutation(artifactId) {
    const active = this.mutations.get(String(artifactId));
    if (!active) return;
    try { await active; } catch { /* reads observe the resulting old/new state */ }
  }

  async #withMutation(artifactId, operation) {
    const id = String(artifactId);
    const previous = this.mutations.get(id);
    const priorSettled = previous ? previous.catch(() => {}) : Promise.resolve();
    const current = priorSettled.then(async () => {
      this.#bumpEpoch(id);
      try { return await operation(); }
      finally { this.#bumpEpoch(id); }
    });
    this.mutations.set(id, current);
    try { return await current; }
    finally { if (this.mutations.get(id) === current) this.mutations.delete(id); }
  }

  async get(descriptorOrId, options = {}) {
    const descriptor = typeof descriptorOrId === 'string' ? null : descriptorOrId;
    const artifactId = String(descriptor?.artifactId ?? descriptorOrId ?? '');
    if (!artifactId) throw new TypeError('artifact-id-required');
    aborted(options.signal);
    this.metrics.requests++;

    // Retrying on a local mutation epoch prevents a get/delete or get/publish
    // race from repopulating the hot cache with an older state after mutation.
    for (;;) {
      await this.#waitForMutation(artifactId);
      aborted(options.signal);
      const epoch = this.#epoch(artifactId);
      const cached = this.hotCache.get(artifactId);
      if (cached) {
        try {
          const payloadBytes = normalizeStoredPayloadBytes(cached.payloadBytes);
          const record = canonicalStoredRecord(cached.record);
          // Cached bytes are still validated on every hit. The cache is not a
          // semantic authority and callers never receive the retained object.
          const validated = validateStoredArtifact({ record, payload:payloadBytes }, {
            artifactId,
            descriptor,
            allowIncomplete:options.allowIncomplete,
          });
          if (!(await this.#upstreamsValid(validated.record, options))) {
            if (epoch !== this.#epoch(artifactId)) { this.metrics.mutationRetries++; continue; }
            return this.#staleDependency(artifactId, 'hot', validated.record, validated.payloadBytes);
          }
          if (epoch !== this.#epoch(artifactId)) { this.metrics.mutationRetries++; continue; }
          this.metrics.hotHits++;
          return { status:'hit', source:'hot', artifactId, record:validated.record, payload:validated.payload };
        } catch (error) {
          this.hotCache.delete(artifactId);
          if (error instanceof ArtifactCorruptionError) {
            if (epoch !== this.#epoch(artifactId)) { this.metrics.mutationRetries++; continue; }
            return this.#invalidResult(artifactId, error, 'hot', cached.record, cached.payloadBytes);
          }
          throw error;
        }
      }

      const source = this.#backendSource();
      let raw;
      try { this.metrics.reads++; raw = await this.backend.getRaw(artifactId); }
      catch (error) { this.metrics.storageFailures++; throw error; }
      aborted(options.signal);
      if (epoch !== this.#epoch(artifactId)) { this.metrics.mutationRetries++; continue; }
      if (!raw) {
        this.metrics.misses++;
        return { status:'miss', source, artifactId, reason:'not-found' };
      }

      try {
        const validated = validateStoredArtifact(raw, {
          artifactId,
          descriptor,
          allowIncomplete:options.allowIncomplete,
        });
        this.metrics.readBytes += validated.payloadBytes.byteLength;
        if (!(await this.#upstreamsValid(validated.record, options))) {
          if (epoch !== this.#epoch(artifactId)) { this.metrics.mutationRetries++; continue; }
          return this.#staleDependency(artifactId, source, validated.record, validated.payloadBytes);
        }
        if (epoch !== this.#epoch(artifactId)) { this.metrics.mutationRetries++; continue; }
        this.hotCache.put(
          artifactId,
          { record:validated.record, payloadBytes:validated.payloadBytes },
          validated.payloadBytes.byteLength,
        );
        if (source === 'persistent') this.metrics.persistentHits++;
        else this.metrics.memoryHits++;
        return { status:'hit', source, artifactId, record:validated.record, payload:validated.payload };
      } catch (error) {
        if (error instanceof ArtifactCorruptionError) {
          if (epoch !== this.#epoch(artifactId)) { this.metrics.mutationRetries++; continue; }
          return this.#invalidResult(artifactId, error, source, raw.record, raw.payload);
        }
        throw error;
      }
    }
  }

  async #upstreamsValid(record, options, context = null) {
    if (options.verifyUpstreams === false) return true;
    const ctx = context || {
      activePath: new Set(),
      validated: new Set(),
      maxNodes: Number.isSafeInteger(options.maxNodes) ? options.maxNodes : 10000,
      nodesVisited: 0,
    };
    const currentId = String(record.artifactId);
    if (ctx.activePath.has(currentId)) return false;
    ctx.activePath.add(currentId);
    try {
      for (const upstreamId of record.upstreamArtifactIds || []) {
        aborted(options.signal);
        if (ctx.activePath.has(upstreamId)) return false;
        if (ctx.validated.has(upstreamId)) continue;
        if (++ctx.nodesVisited > ctx.maxNodes) return false;

        let raw;
        try { this.metrics.reads++; raw = await this.backend.getRaw(upstreamId); }
        catch (error) { this.metrics.storageFailures++; throw error; }
        if (!raw) return false;
        try {
          const validated = validateStoredArtifact(raw, { artifactId:upstreamId });
          this.metrics.readBytes += validated.payloadBytes.byteLength;
          if (!(await this.#upstreamsValid(validated.record, options, ctx))) return false;
          ctx.validated.add(upstreamId);
        } catch (error) {
          if (error instanceof ArtifactCorruptionError) {
            this.metrics.validationFailures++;
            return false;
          }
          throw error;
        }
      }
      return true;
    } finally {
      ctx.activePath.delete(currentId);
    }
  }

  async #deleteObservedArtifact(artifactId, record, payloadBytes) {
    if (this.corruptionPolicy !== 'delete') return false;
    return this.#withMutation(artifactId, async () => {
      this.hotCache.delete(artifactId);
      try {
        if (record && payloadBytes != null && typeof this.backend.deleteIfMatches === 'function') {
          return await this.backend.deleteIfMatches(artifactId, record, payloadBytes);
        }
        // Malformed rows without enough identity to compare are retained rather
        // than risking deletion of a newer cross-context publication. They are
        // still permanently fail-closed on reads.
        return false;
      } catch (error) {
        this.metrics.storageFailures++;
        throw error;
      }
    });
  }

  async #staleDependency(artifactId, source, record, payloadBytes) {
    this.metrics.staleDependencyMisses++;
    this.metrics.misses++;
    this.hotCache.delete(artifactId);
    await this.#deleteObservedArtifact(artifactId, record, payloadBytes);
    return { status:'miss', source, artifactId, reason:'missing-upstream' };
  }

  async #invalidResult(artifactId, error, source, record, payloadBytes) {
    this.metrics.validationFailures++;
    const incompatible = INCOMPATIBLE_CODES.has(error.code);
    if (incompatible) this.metrics.incompatibilities++;
    else this.metrics.corruptions++;
    this.hotCache.delete(artifactId);
    await this.#deleteObservedArtifact(artifactId, record, payloadBytes);
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
    const artifactId = String(descriptor.artifactId);
    aborted(options.signal);

    let payloadBytes;
    let stagedPayload;
    let record;
    try {
      payloadBytes = encodeArtifactPayload(payload);
      stagedPayload = decodeArtifactPayload(payloadBytes);
      record = createArtifactRecord(descriptor, payloadBytes, {
        completeness:options.completeness ?? 'complete',
        creation:options.creation,
      });
    } catch (error) {
      this.metrics.serializationFailures++;
      throw error;
    }

    if (typeof options.validate === 'function') {
      try { await options.validate(stagedPayload, record, { signal:options.signal }); }
      catch (error) { this.metrics.validationFailures++; throw error; }
    }
    aborted(options.signal);

    return this.#withMutation(artifactId, async () => {
      aborted(options.signal);
      let writeResult;
      try {
        writeResult = await this.backend.putAtomic(record, payloadBytes, { signal:options.signal });
      } catch (error) {
        this.hotCache.delete(artifactId);
        if (isAbort(error, options.signal)) this.metrics.cancelledPublishes++;
        else this.metrics.storageFailures++;
        throw error;
      }

      if (options.signal?.aborted) {
        this.metrics.cancelledPublishes++;
        this.hotCache.delete(artifactId);
        // A duplicate means a complete artifact predated this cancelled
        // publication. Never delete that pre-existing CAS entry.
        if (!writeResult?.duplicate) {
          try {
            if (typeof this.backend.deleteIfMatches === 'function') await this.backend.deleteIfMatches(artifactId, record, payloadBytes);
            else await this.backend.delete(artifactId);
          } catch { /* cancellation remains the primary result */ }
        }
        throw options.signal.reason || new DOMException('Aborted', 'AbortError');
      }

      let canonicalRecord;
      let canonicalPayloadBytes;
      let returnedPayload;
      try {
        // On a duplicate publication the backend's existing immutable bytes are
        // authoritative. This keeps hot results identical to close/reopen even
        // when non-key creation metadata differs between producers.
        canonicalRecord = canonicalStoredRecord(writeResult?.record ?? record);
        canonicalPayloadBytes = normalizeStoredPayloadBytes(writeResult?.payload ?? payloadBytes);
        const storedView = { record:canonicalRecord, payload:canonicalPayloadBytes };
        if (Object.hasOwn(writeResult || {}, 'storageEnvelopeSchemaVersion')) storedView.storageEnvelopeSchemaVersion = writeResult.storageEnvelopeSchemaVersion;
        if (Object.hasOwn(writeResult || {}, 'recordChecksum')) storedView.recordChecksum = writeResult.recordChecksum;
        const validated = validateStoredArtifact(
          storedView,
          { artifactId, descriptor, allowIncomplete:(options.completeness ?? 'complete') !== 'complete' },
        );
        canonicalRecord = validated.record;
        canonicalPayloadBytes = validated.payloadBytes;
        returnedPayload = validated.payload;
      } catch (error) {
        this.hotCache.delete(artifactId);
        // No failed publication may survive as a future hit. Do not remove a
        // pre-existing duplicate because this caller did not create it.
        if (!writeResult?.duplicate) {
          try {
            if (typeof this.backend.deleteIfMatches === 'function') await this.backend.deleteIfMatches(artifactId, record, payloadBytes);
            else await this.backend.delete(artifactId);
          } catch { /* preserve the original post-publication failure */ }
        }
        throw error;
      }

      // Do not cache the decoded payload object: callers may mutate return
      // values, while retained CAS bytes must remain immutable.
      this.hotCache.put(
        artifactId,
        { record:canonicalRecord, payloadBytes:canonicalPayloadBytes },
        canonicalPayloadBytes.byteLength,
      );
      this.metrics.publishes++;
      this.metrics.publishBytes += canonicalPayloadBytes.byteLength;
      if (writeResult?.duplicate) this.metrics.duplicatePuts++;
      else {
        this.metrics.writes++;
        this.metrics.writeBytes += canonicalPayloadBytes.byteLength;
      }
      return {
        status:'published',
        artifactId,
        record:canonicalRecord,
        payload:returnedPayload,
        duplicate:!!writeResult?.duplicate,
      };
    });
  }

  async delete(artifactId) {
    const id = String(artifactId ?? '');
    if (!id) throw new TypeError('artifact-id-required');
    return this.#withMutation(id, async () => {
      this.hotCache.delete(id);
      let deleted;
      try { deleted = await this.backend.delete(id); }
      catch (error) { this.metrics.storageFailures++; throw error; }
      if (deleted) this.metrics.deletes++;
      else this.metrics.deleteMisses++;
      return deleted;
    });
  }

  evictHot(artifactId = null) {
    if (artifactId == null) {
      this.hotCache.clear();
      return;
    }
    this.#bumpEpoch(artifactId);
    this.hotCache.delete(artifactId, true);
    this.#bumpEpoch(artifactId);
  }

  async close() {
    const pending = [...this.mutations.values()];
    if (pending.length) await Promise.allSettled(pending);
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
