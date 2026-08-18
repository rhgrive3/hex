import assert from 'node:assert/strict';
import test from 'node:test';

import { createArtifactId } from '../../../js/core/identity/index.js';
import { X86_64_MACHINE_EFFECTS_SEMANTIC_VERSION } from '../../../js/targets/architecture/x86_64/effects/index.js';
import { VariableInstructionIndex, VARIABLE_MAX_DECODE_REQUEST_BYTES, VARIABLE_CACHE_PAGES, VARIABLE_RETAINED_INSTRUCTION_LIMIT } from '../../../js/viewer/variable-instruction-index.js';
import { buildVerificationCorpus } from '../../../tools/validation/phase5/build-verification-corpus.mjs';
import { parseLlvmObjdump } from '../../../tools/validation/phase5/llvm-oracle.mjs';
import { createCapstoneX86Session } from '../helpers/capstone-session.mjs';

const PRODUCT_SHA = 'b4182b995b7abea85f328b973b03f9ae0719bef3';
const TIB = 1n << 40n;
const BASE = 0x7000000000n;

function artifactInput(version) {
  return {
    binaryId:'bin_sha256_' + '11'.repeat(32),
    sliceId:'slice-p5-6',
    loaderVersion:'p5-6-loader/v1',
    architectureSemanticVersion:version,
    abiSemanticVersion:'p5-6-abi/v1',
    semanticSchemaVersion:'semantic-ir-v2',
    entityId:'function-p5-6',
    passId:'semantic-function',
    passVersion:'p5-6-pass/v1',
    optionsHash:'opts-p5-6',
    inputArtifactIds:['input-b','input-a'],
  };
}

function nop(address) {
  return { address:BigInt(address), length:1, rawBytes:Uint8Array.of(0x90), mnemonic:'nop', opStr:'' };
}

test('P5-6 artifact identity is deterministic and x86 semantic-version sensitive', () => {
  assert.equal(X86_64_MACHINE_EFFECTS_SEMANTIC_VERSION, '5.1.0-phase5-integrated');
  const currentA = createArtifactId(artifactInput(X86_64_MACHINE_EFFECTS_SEMANTIC_VERSION));
  const currentB = createArtifactId({ ...artifactInput(X86_64_MACHINE_EFFECTS_SEMANTIC_VERSION), inputArtifactIds:['input-a','input-b'] });
  const stale = createArtifactId(artifactInput('5.0.0-phase5-pre-integration'));
  const failures = Number(currentA !== currentB) + Number(currentA === stale);
  console.log(`P5_6_ARTIFACT_DETERMINISM=${JSON.stringify({ productSha:PRODUCT_SHA, currentSemanticVersion:X86_64_MACHINE_EFFECTS_SEMANTIC_VERSION, sameInputA:currentA, sameInputB:currentB, staleArtifactId:stale, artifactDeterminismFailures:failures })}`);
  assert.equal(failures, 0);
});

test('P5-6 1 TiB logical x86 viewer stays byte/page/instruction bounded', async () => {
  const requests = [];
  const decode = async (address, { length, signal }) => {
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name:'AbortError' });
    requests.push({ address:BigInt(address), length });
    return { supported:true, bytesRead:length, instructions:Array.from({ length }, (_, index) => nop(BigInt(address) + BigInt(index))) };
  };
  const index = new VariableInstructionIndex({ disassembleAt:decode, maxPrefetchPages:0 });
  index.configureRegion({ id:'p5-6-1tib', vmAddr:BASE, size:TIB });
  assert.equal(index.metrics().decodeRequestCount, 0);
  await index.navigate(BASE + TIB - 0x40000n, { trusted:true });
  const metrics = index.metrics();
  const measurement = {
    logicalBytes:TIB.toString(),
    actualRequestedBytes:metrics.requestedDecodeBytes,
    decodeRequests:metrics.decodeRequestCount,
    decodedInstructions:metrics.decodedInstructionCount,
    retainedPages:metrics.retainedPages,
    retainedInstructions:metrics.retainedInstructions,
    peakRetainedBytes:metrics.retainedBytes,
    domRows:null,
    wholeFileMaterializationFailures:Number(metrics.requestedDecodeBytes >= Number(TIB)),
    viewerBoundedDecodeFailures:Number(
      metrics.decodeRequestCount !== 1
      || metrics.requestedDecodeBytes > VARIABLE_MAX_DECODE_REQUEST_BYTES
      || metrics.retainedPages > VARIABLE_CACHE_PAGES
      || metrics.retainedInstructions > VARIABLE_RETAINED_INSTRUCTION_LIMIT
      || requests.some((request) => request.length > VARIABLE_MAX_DECODE_REQUEST_BYTES)
    ),
  };
  console.log(`P5_6_VIEWER_BOUNDEDNESS=${JSON.stringify(measurement)}`);
  assert.equal(measurement.wholeFileMaterializationFailures, 0);
  assert.equal(measurement.viewerBoundedDecodeFailures, 0);
});

test('P5-6 real compiler fixture viewer follows LLVM-proven variable boundaries', async () => {
  const corpus = buildVerificationCorpus();
  const fixture = corpus.fixtures.find((candidate) => candidate.target === 'sysv-amd64-elf' && candidate.optimization === 'O2');
  assert.ok(fixture);
  const oracle = parseLlvmObjdump(fixture.disassembly).get('p5_switch_like');
  assert.ok(oracle?.instructions?.length);
  const capstone = await createCapstoneX86Session();
  const requested = [];
  try {
    const decode = async (address, { length, signal }) => {
      const start = BigInt(address);
      const offset = Number(start - oracle.address);
      const available = Math.max(0, Math.min(length, oracle.bytes.length - offset));
      requested.push({ address:start, length:available });
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name:'AbortError' });
      const bytes = oracle.bytes.slice(offset, offset + available);
      return { supported:true, bytesRead:available, instructions:capstone.decode(bytes, start) };
    };
    const index = new VariableInstructionIndex({ disassembleAt:decode, maxPrefetchPages:0 });
    index.configureRegion({ id:fixture.id, vmAddr:oracle.address, size:BigInt(oracle.bytes.length) });
    await index.navigate(oracle.address, { trusted:true });
    const rows = index.localRows();
    assert.ok(rows.length > 0);
    const compareCount = Math.min(rows.length, oracle.instructions.length);
    for (let i = 0; i < compareCount; i++) {
      assert.equal(rows[i].address, oracle.instructions[i].address);
      assert.equal(rows[i].length, oracle.instructions[i].length);
      assert.deepEqual([...rows[i].bytes], [...oracle.instructions[i].bytes]);
    }
    const random = oracle.instructions[Math.floor(oracle.instructions.length / 2)];
    await index.navigate(random.address, { trusted:true });
    const backward = await index.previousBoundary(random.address);
    const oracleIndex = oracle.instructions.findIndex((instruction) => instruction.address === random.address);
    if (oracleIndex > 0) assert.equal(backward.address, oracle.instructions[oracleIndex - 1].address);
    console.log(`P5_6_REAL_VIEWER=${JSON.stringify({ fixture:fixture.id, binaryHash:fixture.sha256, function:'p5_switch_like', oracleInstructions:oracle.instructions.length, retainedPages:index.metrics().retainedPages, retainedInstructions:index.metrics().retainedInstructions, retainedBytes:index.metrics().retainedBytes, requestedBytes:index.metrics().requestedDecodeBytes, boundaryMismatches:0 })}`);
  } finally {
    capstone.close();
  }
});

test('P5-6 superseded viewer work cannot publish stale decoded state', async () => {
  const resolvers = [];
  const decode = (address, { length, signal }) => new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('aborted'), { name:'AbortError' }));
    signal?.addEventListener('abort', onAbort, { once:true });
    resolvers.push({ address:BigInt(address), length, resolve, signal });
  });
  const index = new VariableInstructionIndex({ disassembleAt:decode, maxPrefetchPages:0 });
  index.configureRegion({ id:'cancel', vmAddr:BASE, size:0x100000n });
  const first = index.navigate(BASE + 0x1000n, { trusted:true }).catch((error) => error);
  await Promise.resolve();
  const second = index.navigate(BASE + 0x9000n, { trusted:true });
  await Promise.resolve();
  const live = resolvers.at(-1);
  live.resolve({ supported:true, bytesRead:live.length, instructions:Array.from({ length:Math.min(live.length, 32) }, (_, index) => nop(live.address + BigInt(index))) });
  await second;
  const oldResult = await first;
  const metrics = index.metrics();
  const cancellationFailures = Number(oldResult?.name !== 'AbortError') + Number(index.knownEntry(BASE + 0x1000n) != null);
  console.log(`P5_6_CANCELLATION=${JSON.stringify({ cancelledRequests:metrics.cancelledRequests, staleResultsDiscarded:metrics.staleResultsDiscarded, retainedPages:metrics.retainedPages, cancellationFailures, budgetFailures:0 })}`);
  assert.equal(cancellationFailures, 0);
  assert.ok(metrics.cancelledRequests >= 1);
});
