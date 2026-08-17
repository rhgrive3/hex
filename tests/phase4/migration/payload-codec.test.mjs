import assert from 'node:assert/strict';

import { ArtifactStore, MemoryArtifactBackend } from '../../../js/core/artifacts/index.js';
import {
  ArtifactAnalysisOrchestrator,
  WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION,
  createWorkerAnalysisArtifactDescriptor,
  decodeWorkerAnalysisPayload,
  encodeWorkerAnalysisPayload,
} from '../../../js/cache/artifact-orchestration.js';

const BINARY_ID = `bin_sha256_${'22'.repeat(32)}`;

function descriptor() {
  return createWorkerAnalysisArtifactDescriptor({
    binaryId:BINARY_ID,
    sliceIndex:0,
    architecture:'arm64',
    producerVersion:'producer-v1',
    loaderVersion:'loader-v1',
    architectureSemanticVersion:'arch-v1',
    abiSemanticVersion:'abi-v1',
    semanticSchemaVersion:'semantic-v1',
    config:{ fixture:'codec' },
  });
}

function fixture() {
  const raw = Uint8Array.from([1, 2, 3, 255]);
  const buffer = raw.buffer.slice(0);
  const viewBytes = Uint8Array.from([9, 8, 7, 6]);
  return {
    address:0x100000000n,
    signed:-42n,
    addrs:new BigUint64Array([0x1000n, 0x2000n]),
    signedWords:new BigInt64Array([-1n, 2n]),
    kinds:new Uint8Array([1, 2, 255]),
    words:new Uint32Array([1, 0xffffffff]),
    floats:new Float64Array([1.5, -2.25]),
    buffer,
    view:new DataView(viewBytes.buffer, 1, 2),
    map:new Map([['x', 1n], ['y', new Uint16Array([7, 8])]]),
    set:new Set(['a', 3n]),
    date:new Date('2026-08-17T00:00:00.000Z'),
    nan:NaN,
    positiveInfinity:Infinity,
    negativeInfinity:-Infinity,
    negativeZero:-0,
    missing:undefined,
    nested:[{ ok:true }, null],
  };
}

// Direct codec proof: every structured-clone-safe worker result type that JSON
// would otherwise erase is restored exactly.
{
  const value = fixture();
  const encoded = encodeWorkerAnalysisPayload(value);
  assert.equal(encoded.codec, WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION);
  const decoded = decodeWorkerAnalysisPayload(encoded);
  assert.deepEqual(decoded, value);
  assert.ok(decoded.addrs instanceof BigUint64Array);
  assert.ok(decoded.kinds instanceof Uint8Array);
  assert.ok(decoded.view instanceof DataView);
  assert.equal(decoded.address, 0x100000000n);
  assert.ok(Number.isNaN(decoded.nan));
  assert.ok(Object.is(decoded.negativeZero, -0));
}

// ArtifactStore cold and warm paths both preserve the old public result type.
{
  const store = new ArtifactStore({ backend:new MemoryArtifactBackend({ reason:'explicit-codec-test' }) });
  const runtime = new ArtifactAnalysisOrchestrator({ store });
  const d = descriptor();
  const expected = fixture();
  let calls = 0;

  const cold = await runtime.request({ descriptor:d, produce:async () => { calls++; return expected; } });
  assert.equal(cold.reused, false);
  assert.deepEqual(cold.payload, expected);
  assert.ok(cold.payload.addrs instanceof BigUint64Array);
  assert.equal(calls, 1);

  const warm = await runtime.request({ descriptor:d, produce:async () => { calls++; return fixture(); } });
  assert.equal(warm.reused, true);
  assert.deepEqual(warm.payload, expected);
  assert.ok(warm.payload.addrs instanceof BigUint64Array);
  assert.equal(calls, 1, 'warm reuse must not run the worker producer');

  const raw = await store.get(d);
  assert.equal(raw.status, 'hit');
  assert.equal(raw.payload.codec, WORKER_ANALYSIS_PAYLOAD_CODEC_VERSION, 'stored payload is explicitly versioned transport data');
  await runtime.close();
}

console.log('phase4 migration payload codec: PASS');
