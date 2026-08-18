import assert from 'node:assert/strict';
import test from 'node:test';

import { ArtifactAnalysisOrchestrator } from '../../../js/cache/artifact-orchestration.js';
import { ArtifactStore, MemoryArtifactBackend } from '../../../js/core/artifacts/index.js';
import { AnalysisScheduler } from '../../../js/core/scheduler/index.js';
import { analyzeDecodedSemanticFunction } from '../../../js/analysis/semantic-function.js';
import { parseELF } from '../../../js/binary/elf.js';
import { buildPhase6VerificationCorpus } from '../../../tools/validation/phase6/build-verification-corpus.mjs';
import { parseLlvmObjdump } from '../../../tools/validation/phase6/llvm-oracle.mjs';
import { createCapstoneRiscv64Session } from '../helpers/capstone-session.mjs';

/**
 * RISC-V through the production Backend orchestration, not just through the
 * shared analysis module.
 *
 * This is the difference between "the pipeline can analyse RISC-V" and "the
 * product routes RISC-V": artifact identity, the decode worker boundary, the
 * platform worker boundary, caching and warm reuse all have to agree on the
 * architecture. The workers below are the same message contracts the browser
 * uses, driven by the deployed Capstone bundle.
 */

const corpus = buildPhase6VerificationCorpus();
const fixture = corpus.fixtures.find((item) => item.id === 'riscv64-lp64-exec-O1');
assert.ok(fixture, 'the Backend route test needs a corpus fixture');
const oracle = parseLlvmObjdump(fixture.disassembly);
const target = oracle.get('p6_conditional_branch_without_flags');
assert.ok(target?.instructions?.length, 'the corpus function must be present');

const image = parseELF(new Uint8Array(fixture.bytes));
const executable = image.sections.find((section) => section.perms?.execute && section.address <= target.address);
assert.ok(executable, 'an executable section covering the function must be mapped');
const fileOffset = BigInt(executable.fileOffset) + (target.address - BigInt(executable.address));

const capstone = await createCapstoneRiscv64Session();
let semanticCalls = 0;

class ProductionRouteWorker {
  constructor(url) {
    this.url = String(url);
    this.onmessage = null;
    this.onerror = null;
  }

  postMessage(message) {
    queueMicrotask(async () => {
      try {
        if (/capstone-probe-worker\.js$/.test(this.url)) {
          this.onmessage?.({ data:{ ok:true, support:{ arm64:true, x86_64:true, riscv64:true } } });
          return;
        }
        if (/capstone-disasm-worker\.js$/.test(this.url)) {
          assert.equal(message.architecture, 'riscv64', 'the Backend must ask the decoder for riscv64');
          const instructions = capstone.decode(message.bytes, BigInt(message.address));
          this.onmessage?.({ data:{ id:message.id, ok:true, instructions, decoder:'capstone', architecture:'riscv64' } });
          return;
        }
        if (/platform\/worker\.js$/.test(this.url)) {
          let result;
          if (message.t === 'readAt') {
            const requested = BigInt(message.addr);
            result = requested === target.address
              ? { found:true, fileOffset, bytes:target.bytes.slice(0, message.len) }
              : { found:false, bytes:new Uint8Array(0) };
          } else if (message.t === 'semanticFunction') {
            semanticCalls += 1;
            assert.equal(message.input.architecture, 'riscv64');
            assert.equal(message.input.abiId, 'lp64');
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
        // must never be asked to do RISC-V work.
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

test('the production Backend routes RISC-V through the shared semantic-function artifact', async (t) => {
  t.after(() => capstone.close());
  const store = new ArtifactStore({ backend:new MemoryArtifactBackend() });
  const scheduler = new AnalysisScheduler({ store, maxConcurrency:1, starvationInterval:4 });
  const backend = new Backend({ artifactOrchestrator:new ArtifactAnalysisOrchestrator({ store, scheduler }) });
  backend.file = new Blob([new Uint8Array(fixture.bytes)]);
  backend.formatId = 'elf';
  backend.platformInfo = { capability:{ architecture:'riscv64' }, slices:[{ capability:{ architecture:'riscv64' } }] };

  const options = {
    architecture:'riscv64',
    address:target.address,
    length:Number(target.endAddress - target.address),
    abiId:'lp64',
    platform:'linux',
    name:'p6_conditional_branch_without_flags',
    completeness:'complete',
  };

  const cold = await backend.analyzeSemanticFunction(options);
  assert.equal(cold.route, 'phase5-shadow-v2', 'the shared route identity is the route, not an architecture');
  assert.equal(cold.architectureId, 'riscv64');
  assert.equal(cold.abiId, 'lp64');
  assert.equal(cold.pipeline.instrumentation.v2Executed, true);
  assert.equal(cold.pipeline.instrumentation.provenanceLossCount, 0);
  assert.equal(cold.pipeline.instrumentation.unsupportedInstructionCount, 0);
  assert.equal(cold.pipeline.machineEffects.every((bundle) => bundle.completeness === 'exact'), true);
  assert.equal(cold.pipeline.machineEffects.some((bundle) => bundle.controlEffect.kind === 'conditional-branch'), true);
  assert.equal(cold.pipeline.machineEffects.some((bundle) => bundle.controlEffect.kind === 'return'), true);
  assert.equal(cold.pipeline.machineEffects.flatMap((bundle) => bundle.operations).some((operation) => operation.kind === 'flag-read' || operation.kind === 'flag-write'), false,
    'the production route must not acquire flag state on the way through');
  assert.ok(cold.pipeline.ssa.definitions.length > 0);
  assert.ok(cold.pipeline.memorySsa.definitions);
  assert.equal(cold.pipeline.legacyV1.compat.projection, 'semantic-ir-v2-to-v1');
  assert.equal(cold.decompiler.semantic, true);
  assert.match(cold.decompiler.pseudocode, /p6_conditional_branch_without_flags/);
  assert.equal(cold.reused, false);

  // Warm reuse must hit the same artifact without recomputing.
  const warm = await backend.analyzeSemanticFunction(options);
  assert.equal(warm.artifactId, cold.artifactId);
  assert.equal(warm.reused, true);
  assert.equal(semanticCalls, 1, 'a warm request must not re-run the analysis');
});

test('the Backend refuses an ABI that does not belong to the requested architecture', async () => {
  const store = new ArtifactStore({ backend:new MemoryArtifactBackend() });
  const scheduler = new AnalysisScheduler({ store, maxConcurrency:1, starvationInterval:4 });
  const backend = new Backend({ artifactOrchestrator:new ArtifactAnalysisOrchestrator({ store, scheduler }) });
  backend.file = new Blob([new Uint8Array(fixture.bytes)]);
  backend.formatId = 'elf';

  await assert.rejects(
    backend.analyzeSemanticFunction({ architecture:'riscv64', address:target.address, length:16, abiId:'sysv-amd64' }),
    /semantic-function-riscv64-abi-required/,
    'an x86 ABI must not be accepted for a RISC-V request',
  );
  await assert.rejects(
    backend.analyzeSemanticFunction({ architecture:'riscv32', address:target.address, length:16, abiId:'lp64' }),
    /semantic-function-unsupported-architecture:riscv32/,
    'an unregistered architecture must be refused, not routed as something else',
  );
});
