import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeDecodedSemanticFunction } from '../../../js/targets/architecture/x86_64/semantic-function.js';
import { ArtifactAnalysisOrchestrator } from '../../../js/cache/artifact-orchestration.js';
import { ArtifactStore, MemoryArtifactBackend } from '../../../js/core/artifacts/index.js';
import { AnalysisScheduler } from '../../../js/core/scheduler/index.js';
import { createCapstoneX86Session } from '../helpers/capstone-session.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'tests/phase5/corpus/manifest.json'), 'utf8'));
const capstone = await createCapstoneX86Session();
let activeFixture = null;
const workers = [];

class ProductionRouteWorker {
  constructor(url) {
    this.url = String(url);
    this.onmessage = null;
    this.onerror = null;
    this.messages = [];
    workers.push(this);
  }

  postMessage(message) {
    this.messages.push(message);
    queueMicrotask(async () => {
      try {
        if (/capstone-probe-worker\.js$/.test(this.url)) {
          this.onmessage?.({ data:{ ok:true, support:{ arm64:true, x86_64:true } } });
          return;
        }
        if (/capstone-disasm-worker\.js$/.test(this.url)) {
          const instructions = capstone.decode(message.bytes, BigInt(message.address));
          this.onmessage?.({ data:{ id:message.id, ok:true, instructions, decoder:'capstone', architecture:'x86_64' } });
          return;
        }
        if (/platform\/worker\.js$/.test(this.url)) {
          let result;
          if (message.t === 'readAt') {
            const requested = BigInt(message.addr);
            result = requested === activeFixture.address
              ? { found:true, fileOffset:activeFixture.fileOffset, bytes:activeFixture.code.slice(0, message.len) }
              : { found:false, bytes:new Uint8Array(0) };
          } else if (message.t === 'semanticFunction') {
            result = analyzeDecodedSemanticFunction(message.input, { signal:null });
          } else if (message.t === 'memoryStats' || message.t === 'cleanupMemory') {
            result = { bounded:true };
          } else {
            throw new Error(`unexpected-platform-worker-message:${message.t}`);
          }
          this.onmessage?.({ data:{ t:'ok', id:message.id, epoch:message.epoch, result } });
          return;
        }
        // The legacy ARM64 compatibility worker is constructed by Backend but
        // is deliberately not invoked by this explicit x86 route.
        if (/\/worker\.js$/.test(this.url) && message.t !== 'cancel') throw new Error(`unexpected-legacy-worker-message:${message.t}`);
      } catch (error) {
        if (/platform\/worker\.js$/.test(this.url)) this.onmessage?.({ data:{ t:'err', id:message.id, epoch:message.epoch, error:error.message } });
        else this.onmessage?.({ data:{ id:message.id, ok:false, error:error.message } });
      }
    });
  }

  terminate() {}
}

globalThis.Worker = ProductionRouteWorker;
const { Backend } = await import('../../../js/backend.js');

function canonicalRuntime() {
  const store = new ArtifactStore({ backend:new MemoryArtifactBackend() });
  const scheduler = new AnalysisScheduler({ store, maxConcurrency:1, starvationInterval:4 });
  return new ArtifactAnalysisOrchestrator({ store, scheduler });
}

function fixtureBytes(entry) {
  const file = fs.readFileSync(path.join(root, entry.path));
  const offset = entry.abiId === 'sysv-amd64' ? 0x1000 : 0x400;
  return { file, offset, code:new Uint8Array(file.buffer, file.byteOffset + offset, entry.functionLength).slice() };
}

const runtime = canonicalRuntime();
const results = [];
try {
  for (const entry of manifest.foundationVerticalFixtures) {
    const fixture = fixtureBytes(entry);
    activeFixture = { address:BigInt(entry.entryAddress), fileOffset:BigInt(fixture.offset), code:fixture.code };
    const backend = new Backend({ artifactOrchestrator:runtime });
    backend.file = new Blob([fixture.file]);
    backend.formatId = entry.abiId === 'microsoft-x64' ? 'pe' : 'elf';
    backend.platformInfo = { capability:{ architecture:'x86_64' }, slices:[{ capability:{ architecture:'x86_64' } }] };

    const options = {
      address:activeFixture.address,
      length:entry.functionLength,
      abiId:entry.abiId,
      platform:entry.abiId === 'microsoft-x64' ? 'windows' : 'linux',
      name:'p5_vertical_seed',
      completeness:'complete',
    };
    const cold = await backend.analyzeSemanticFunction(options);
    const warm = await backend.analyzeSemanticFunction(options);
    assert.equal(cold.route, 'phase5-shadow-v2');
    assert.equal(cold.abiId, entry.abiId);
    assert.equal(cold.pipeline.instrumentation.v2Executed, true);
    assert.equal(cold.pipeline.instrumentation.provenanceLossCount, 0);
    assert.equal(cold.pipeline.machineEffects.length, entry.abiId === 'sysv-amd64' ? 25 : 26);
    assert.ok(cold.pipeline.machineEffects.some((bundle) => bundle.operations.some((operation) => operation.kind === 'memory-read')));
    assert.ok(cold.pipeline.machineEffects.some((bundle) => bundle.operations.some((operation) => operation.kind === 'memory-write')));
    assert.ok(cold.pipeline.machineEffects.some((bundle) => bundle.controlEffect.kind === 'conditional-branch'));
    assert.ok(cold.pipeline.machineEffects.some((bundle) => bundle.operations.some((operation) => operation.kind === 'value' && ['add','sub'].includes(operation.opcode))));
    assert.ok(cold.pipeline.machineEffects.some((bundle) => bundle.metadata?.instructionFamily === 'cmp'
      && bundle.operations.some((operation) => operation.kind === 'flag-write')
      && !bundle.operations.some((operation) => operation.kind === 'memory-write')),
    `CMP must update flags without a destination write: ${JSON.stringify(cold.pipeline.machineEffects.map((bundle) => bundle.metadata))}`);
    assert.ok(cold.pipeline.machineEffects.some((bundle) => bundle.controlEffect.kind === 'return'));
    assert.equal(cold.pipeline.machineEffects.some((bundle) => bundle.completeness === 'unknown'), false,
      `foundation seed must not hide unsupported semantics: ${cold.pipeline.machineEffects.filter((bundle) => bundle.completeness === 'unknown').map((bundle) => bundle.metadata?.instructionFamily).join(',')}`);
    if (entry.abiId === 'sysv-amd64') {
      assert.ok(cold.pipeline.machineEffects.some((bundle) => bundle.operations.some((operation) => operation.kind === 'value'
        && operation.opcode === 'insert' && operation.metadata?.view === 'al' && operation.metadata?.physicalId === 'rax')),
      'SysV seed must prove AL and RAX share one physical identity');
    } else {
      assert.ok(cold.pipeline.machineEffects.some((bundle) => bundle.operations.some((operation) => operation.kind === 'register-write'
        && operation.metadata?.view === 'eax' && operation.metadata?.writePolicy === 'zero-extend-32')),
      'Microsoft seed must prove EAX writes zero-extend the RAX physical identity');
    }
    assert.ok(cold.pipeline.ssa.definitions.length > 0);
    assert.ok(cold.pipeline.memorySsa.definitions.length > 0);
    assert.equal(cold.pipeline.legacyV1.compat.projection, 'semantic-ir-v2-to-v1');
    assert.equal(cold.decompiler.semantic, true);
    assert.match(cold.decompiler.pseudocode, /p5_vertical_seed/);
    const sampleBundle = cold.pipeline.machineEffects.find((bundle) => bundle.operations.some((operation) => operation.kind === 'memory-write'));
    assert.ok(sampleBundle?.origin?.byteRanges?.length, 'sampled MachineEffects must retain the binary byte range');
    assert.ok(sampleBundle.origin.virtualRanges.length, 'sampled MachineEffects must retain its virtual range');
    const sampleInstructionId = sampleBundle.instructionId;
    const hasSample = (origin) => origin?.instructionIds?.includes(sampleInstructionId);
    assert.ok(cold.pipeline.semanticIr.nodes.some((node) => hasSample(node.origin)), 'Semantic IR must retain sampled instruction provenance');
    assert.ok(cold.pipeline.ssa.definitions.some((definition) => hasSample(definition.origin)), 'SSA must retain sampled instruction provenance');
    assert.ok(cold.pipeline.memorySsa.definitions.some((definition) => hasSample(definition.origin)), 'MemorySSA must retain sampled store provenance');
    const projected = cold.pipeline.legacyV1.instructions.filter((instruction) => hasSample(instruction.origin));
    assert.ok(projected.length, 'compatibility projection must retain sampled instruction provenance');
    const projectedIds = new Set(projected.map((instruction) => instruction.id));
    assert.ok(cold.decompiler.lines.some((line) => line.source?.ir?.some((id) => projectedIds.has(id))), 'final decompiler evidence must resolve to sampled projected IR provenance');
    assert.equal(warm.artifactId, cold.artifactId);
    assert.equal(warm.reused, true, `second identical request must reuse the canonical artifact: ${JSON.stringify(runtime.stats())}`);
    assert.deepEqual(warm.pipeline.semanticIr, cold.pipeline.semanticIr, 'cold and warm semantic results must agree');
    results.push({
      abiId:entry.abiId,
      artifactId:cold.artifactId,
      instructions:cold.pipeline.machineEffects.length,
      exact:cold.pipeline.machineEffects.filter((bundle) => bundle.completeness === 'exact').length,
      exactWithIntrinsic:cold.pipeline.machineEffects.filter((bundle) => bundle.completeness === 'exact-with-intrinsic').length,
      partial:cold.pipeline.machineEffects.filter((bundle) => bundle.completeness === 'partial').length,
      unknown:cold.pipeline.machineEffects.filter((bundle) => bundle.completeness === 'unknown').length,
    });
    backend.dispose();
  }

  assert.notEqual(results[0].artifactId, results[1].artifactId, 'SysV and Microsoft ABI artifacts must never collide');
  const metrics = runtime.stats();
  assert.equal(metrics.producerInvocations, 2);
  assert.equal(metrics.coldPublishes, 2);
  assert.equal(metrics.warmReuses, 2);

  const cancelledBackend = new Backend({ artifactOrchestrator:runtime });
  const cancelledFixture = fixtureBytes(manifest.foundationVerticalFixtures[0]);
  activeFixture = { address:BigInt(manifest.foundationVerticalFixtures[0].entryAddress), fileOffset:BigInt(cancelledFixture.offset), code:cancelledFixture.code };
  cancelledBackend.file = new Blob([cancelledFixture.file]);
  cancelledBackend.formatId = 'elf';
  cancelledBackend.platformInfo = { capability:{ architecture:'x86_64' } };
  const controller = new AbortController();
  controller.abort(new DOMException('foundation cancellation', 'AbortError'));
  await assert.rejects(cancelledBackend.analyzeSemanticFunction({
    address:activeFixture.address, length:77, abiId:'sysv-amd64', platform:'linux', signal:controller.signal,
  }), (error) => error?.name === 'AbortError');
  cancelledBackend.dispose();
  assert.equal(runtime.store.stats().cancelledPublishes, 0, 'pre-cancelled work must publish no zombie artifact');

  console.log('PHASE5_VERTICAL_SPINE ' + JSON.stringify({ results, metrics:runtime.stats(), provenanceLossCount:0, hiddenFallbackCount:0 }));
  console.log('phase5 production Backend x86 vertical shadow route passed');
} finally {
  capstone.close();
  await runtime.close();
}
