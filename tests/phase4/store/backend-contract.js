import assert from "node:assert/strict";
import {
  createArtifactDescriptor,
  createArtifactRecord,
  encodeArtifactPayload,
  ArtifactStorageError,
} from "../../../js/core/artifacts/contracts.js";

export async function runArtifactBackendContract({
  name,
  createBackend,
  destroyBackend = async () => {},
}) {
  console.log(`Running ArtifactBackend conformance suite for ${name}...`);

  function fixture(num = 1) {
    const desc = createArtifactDescriptor({
      binaryId: "bin_sha256_" + "1".repeat(64),
      passId: "test-pass",
      artifactKind: "test-kind",
      producerId: "test-prod",
      loaderVersion: "1.0.0",
      architectureSemanticVersion: "1.0.0",
      abiSemanticVersion: "1.0.0",
      semanticSchemaVersion: "1.0.0",
      config: { testNum: num },
    });
    const payloadBytes = encodeArtifactPayload({ hello: "world", n: num });
    const record = createArtifactRecord(desc, payloadBytes, {
      completeness: "complete",
    });
    return { desc, record, payloadBytes };
  }

  // 1. Capabilities are immutable and identify backend
  {
    const backend = await createBackend();
    try {
      const caps = backend.capabilities();
      assert.ok(caps && typeof caps === "object");
      assert.ok(typeof caps.backend === "string" && caps.backend.length > 0);
      assert.ok(typeof caps.persistent === "boolean");
      assert.ok(Object.isFrozen(caps));
      const caps2 = backend.capabilities();
      assert.deepEqual(caps, caps2);
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 1 capabilities");
  }

  // 2. Empty read/has
  {
    const backend = await createBackend();
    try {
      assert.equal(await backend.getRaw("non-existent-id"), null);
      assert.equal(await backend.has("non-existent-id"), false);
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 2 empty read/has");
  }

  // 3. First atomic publication
  {
    const backend = await createBackend();
    try {
      const { record, payloadBytes } = fixture(1);
      const res = await backend.putAtomic(record, payloadBytes);
      assert.equal(res.duplicate, false);
      assert.equal(await backend.has(record.artifactId), true);
      const raw = await backend.getRaw(record.artifactId);
      assert.ok(raw);
      assert.deepEqual(raw.record.artifactId, record.artifactId);
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 3 first atomic publication");
  }

  // 4. Returned data is isolated from caller mutation
  {
    const backend = await createBackend();
    try {
      const { record, payloadBytes } = fixture(1);
      const res = await backend.putAtomic(record, payloadBytes);
      if (res.payload && res.payload.length > 0) res.payload[0] = 0xff;
      const raw = await backend.getRaw(record.artifactId);
      assert.deepEqual([...raw.payload], [...payloadBytes]);
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 4 data isolation");
  }

  // 5. Exact duplicate publication
  {
    const backend = await createBackend();
    try {
      const { record, payloadBytes } = fixture(1);
      const r1 = await backend.putAtomic(record, payloadBytes);
      assert.equal(r1.duplicate, false);
      const r2 = await backend.putAtomic(record, payloadBytes);
      assert.equal(r2.duplicate, true);
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 5 exact duplicate publication");
  }

  // 6. Immutable conflict
  {
    const backend = await createBackend();
    try {
      const { record, payloadBytes } = fixture(1);
      await backend.putAtomic(record, payloadBytes);
      const diffBytes = new Uint8Array(payloadBytes.length);
      diffBytes.set(payloadBytes);
      diffBytes[diffBytes.length - 1] ^= 1;
      await assert.rejects(async () => {
        await backend.putAtomic(record, diffBytes);
      }, (err) => {
        return err.name === "ArtifactStorageError" && err.code === "artifact-immutable-conflict";
      });
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 6 immutable conflict");
  }

  // 7. Delete hit/miss
  {
    const backend = await createBackend();
    try {
      const { record, payloadBytes } = fixture(1);
      await backend.putAtomic(record, payloadBytes);
      assert.equal(await backend.delete(record.artifactId), true);
      assert.equal(await backend.has(record.artifactId), false);
      assert.equal(await backend.getRaw(record.artifactId), null);
      assert.equal(await backend.delete(record.artifactId), false);
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 7 delete hit/miss");
  }

  // 8. deleteIfMatches mismatch
  {
    const backend = await createBackend();
    try {
      const { record, payloadBytes } = fixture(1);
      await backend.putAtomic(record, payloadBytes);
      const fakeRec = { ...record, completeness: "partial" };
      assert.equal(await backend.deleteIfMatches(record.artifactId, fakeRec, payloadBytes), false);
      assert.equal(await backend.has(record.artifactId), true);
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 8 deleteIfMatches mismatch");
  }

  // 9. deleteIfMatches exact match deletes
  {
    const backend = await createBackend();
    try {
      const { record, payloadBytes } = fixture(1);
      await backend.putAtomic(record, payloadBytes);
      assert.equal(await backend.deleteIfMatches(record.artifactId, record, payloadBytes), true);
      assert.equal(await backend.has(record.artifactId), false);
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 9 deleteIfMatches exact match");
  }

  // 10. Pre-aborted publication
  {
    const backend = await createBackend();
    try {
      const { record, payloadBytes } = fixture(1);
      const ac = new AbortController();
      ac.abort();
      await assert.rejects(async () => {
        await backend.putAtomic(record, payloadBytes, { signal: ac.signal });
      });
      assert.equal(await backend.has(record.artifactId), false);
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 10 pre-aborted publication");
  }

  // 11. Concurrent exact duplicate publication
  {
    const backend = await createBackend();
    try {
      const { record, payloadBytes } = fixture(1);
      const [r1, r2] = await Promise.all([
        backend.putAtomic(record, payloadBytes),
        backend.putAtomic(record, payloadBytes),
      ]);
      assert.equal([r1.duplicate, r2.duplicate].sort().join(","), "false,true");
      assert.equal(await backend.has(record.artifactId), true);
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 11 concurrent duplicate");
  }

  // 12. Concurrent conflicting publication
  {
    const backend = await createBackend();
    try {
      const { record, payloadBytes } = fixture(1);
      const diffBytes = new Uint8Array(payloadBytes.length);
      diffBytes.set(payloadBytes);
      diffBytes[diffBytes.length - 1] ^= 1;
      const res = await Promise.allSettled([
        backend.putAtomic(record, payloadBytes),
        backend.putAtomic(record, diffBytes),
      ]);
      const fulfilled = res.filter((r) => r.status === "fulfilled");
      const rejected = res.filter((r) => r.status === "rejected");
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0].reason.code, "artifact-immutable-conflict");
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 12 concurrent conflicting");
  }

  // 13. close() idempotency
  {
    const backend = await createBackend();
    await backend.close();
    await backend.close();
    await destroyBackend(backend);
    console.log("  ok 13 close idempotency");
  }

  // 14. Stats common fields
  {
    const backend = await createBackend();
    try {
      const { record, payloadBytes } = fixture(1);
      await backend.putAtomic(record, payloadBytes);
      await backend.getRaw(record.artifactId);
      await backend.has(record.artifactId);
      await backend.delete(record.artifactId);
      const st = backend.stats();
      assert.ok(st && typeof st === "object");
      assert.ok(st.reads >= 1);
      assert.ok(st.writes >= 1);
      assert.ok(st.hasChecks >= 1);
      assert.ok(st.deletes >= 1);
    } finally {
      await backend.close();
      await destroyBackend(backend);
    }
    console.log("  ok 14 stats common fields");
  }

  console.log(`ArtifactBackend conformance suite for ${name} PASSED!`);
}
