import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createBinaryIdFromDigest, createInstructionId, createSliceId } from '../../../js/core/identity/index.js';
import { analyzeDecodedSemanticFunction } from '../../../js/analysis/semantic-function.js';
import { buildPhase6VerificationCorpus, corpusDigest } from '../../../tools/validation/phase6/build-verification-corpus.mjs';
import { compareDecodedWithOracle, compareWithCapstoneOperands, parseLlvmObjdump } from '../../../tools/validation/phase6/llvm-oracle.mjs';
import { createCapstoneRiscv64Session } from '../helpers/capstone-session.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROFILE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/validation/phase6/profile.json'), 'utf8'));
const CATEGORY_MAP = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/phase6/verification/manifests/p6-category-map.json'), 'utf8'));

function completenessCounts(bundles) {
  const out = { exact: 0, exactWithIntrinsic: 0, partial: 0, unknown: 0, unsupported: 0 };
  for (const bundle of bundles || []) {
    if (bundle.completeness === 'exact') out.exact += 1;
    else if (bundle.completeness === 'exact-with-intrinsic') out.exactWithIntrinsic += 1;
    else if (bundle.completeness === 'partial') out.partial += 1;
    else if (bundle.completeness === 'unknown') out.unknown += 1;
    else out.unsupported += 1;
  }
  return out;
}

function operationsOf(analysis) {
  return (analysis?.pipeline?.machineEffects || []).flatMap((bundle) => bundle.operations || []);
}
function valueOpcodes(analysis) {
  return new Set(operationsOf(analysis).filter((operation) => operation.kind === 'value').map((operation) => String(operation.opcode)));
}
function controlKinds(analysis) {
  return new Set((analysis?.pipeline?.machineEffects || []).map((bundle) => bundle.controlEffect?.kind).filter(Boolean));
}

/** Does the recovered CFG contain a cycle? Proof of loop recovery in the shared middle-end. */
function cfgHasCycle(cfg) {
  const successors = new Map((cfg?.blocks || []).map((block) => [block.id, (block.successors || []).map((edge) => edge.to)]));
  const state = new Map();
  const visit = (id) => {
    const current = state.get(id);
    if (current === 'active') return true;
    if (current === 'done') return false;
    state.set(id, 'active');
    for (const next of successors.get(id) || []) if (successors.has(next) && visit(next)) return true;
    state.set(id, 'done');
    return false;
  };
  for (const id of successors.keys()) if (visit(id)) return true;
  return false;
}

function provenanceFailures(analysis) {
  const bundles = analysis?.pipeline?.machineEffects || [];
  const failures = [];
  for (const bundle of bundles) {
    const id = bundle.instructionId;
    const has = (origin) => origin?.instructionIds?.includes(id);
    if (!has(bundle.origin)) failures.push({ instructionId: id, stage: 'MachineEffects' });
    if (!analysis.pipeline.semanticIr.nodes.some((node) => has(node.origin))) failures.push({ instructionId: id, stage: 'Semantic IR' });
    const writesState = bundle.operations?.some((operation) => ['register-write', 'value', 'memory-write'].includes(operation.kind));
    if (writesState && !analysis.pipeline.ssa.definitions.some((definition) => has(definition.origin))) {
      failures.push({ instructionId: id, stage: 'SSA' });
    }
  }
  return failures;
}

/**
 * Independent, structure-based proof that this fixture really exercises the
 * category. `asm` comes from LLVM's disassembly, never from Hex, and the
 * semantic requirements read structured pipeline output, never pseudocode text.
 */
function categoryFailures(category, mapping, { asm, analysis, decoded, fixture }) {
  const failures = [];
  const require_ = (condition, code) => { if (!condition) failures.push(code); };
  const opcodes = valueOpcodes(analysis);
  const controls = controlKinds(analysis);
  const operations = operationsOf(analysis);
  const bundles = analysis?.pipeline?.machineEffects || [];
  const registerWrites = operations.filter((operation) => operation.kind === 'register-write');
  const registerReads = operations.filter((operation) => operation.kind === 'register-read');
  const memoryReads = operations.filter((operation) => operation.kind === 'memory-read');
  const memoryWrites = operations.filter((operation) => operation.kind === 'memory-write');

  if (mapping.requiredMnemonicPattern) {
    require_(new RegExp(mapping.requiredMnemonicPattern, 'i').test(asm), 'required-mnemonic-absent-from-llvm-disassembly');
  }
  if (mapping.requiresControlEffect) require_(controls.has(mapping.requiresControlEffect), `control-effect-absent:${mapping.requiresControlEffect}`);
  if (mapping.requiresComparePredicate) {
    require_(mapping.requiresComparePredicate.some((predicate) => opcodes.has(`icmp.${predicate}`)), 'compare-predicate-not-materialized');
  }
  if (mapping.requiresBackEdge) require_(cfgHasCycle(analysis.pipeline.cfg), 'cfg-has-no-back-edge');
  if (mapping.requiresMultiwayBranching) {
    const conditional = bundles.filter((bundle) => bundle.controlEffect?.kind === 'conditional-branch').length;
    require_(conditional >= 3 || controls.has('indirect'), 'multiway-control-flow-not-recovered');
  }
  if (mapping.requiresStackMemory) {
    // LLVM may address the frame through a copy of sp rather than printing a
    // literal `(sp)` operand, so the independent proof is that the function
    // manipulates the stack pointer at all; the structural requirements below
    // then prove the access really reached the memory pipeline.
    require_(/\bsp\b/i.test(asm), 'stack-pointer-absent-from-llvm-disassembly');
    require_(registerReads.some((operation) => operation.register?.registerId === 'x2'), 'stack-pointer-not-read');
    require_(memoryReads.length > 0 || memoryWrites.length > 0, 'stack-memory-access-not-emitted');
  }
  if (mapping.requiresMemoryRead) require_(memoryReads.length > 0, 'memory-read-not-emitted');
  if (mapping.requiresMemoryWrite) require_(memoryWrites.length > 0, 'memory-write-not-emitted');
  if (mapping.requiresDirectCall) {
    require_(bundles.some((bundle) => bundle.controlEffect?.kind === 'call' && bundle.controlEffect.target?.kind === 'absolute-address'), 'direct-call-not-emitted');
  }
  if (mapping.requiresIndirectCall) {
    require_(bundles.some((bundle) => bundle.controlEffect?.kind === 'call' && bundle.controlEffect.target?.kind !== 'absolute-address'), 'indirect-call-not-emitted');
  }
  if (mapping.requiresArgumentRegisters) {
    const read = new Set(registerReads.map((operation) => operation.register?.registerId));
    for (const register of mapping.requiresArgumentRegisters) require_(read.has(register), `argument-register-not-read:${register}`);
  }
  if (mapping.requiresReturnRegisterWrite) {
    require_(registerWrites.some((operation) => operation.register?.registerId === mapping.requiresReturnRegisterWrite), 'return-register-not-written');
  }
  if (mapping.requiresWordResultExtension) {
    require_(bundles.some((bundle) => bundle.metadata?.resultExtension === 'sign-extend-to-xlen'), 'rv64-w-suffix-sign-extension-not-modeled');
  }
  if (mapping.requiresExtensionOperations) {
    for (const operation of mapping.requiresExtensionOperations) require_(opcodes.has(operation), `extension-operation-absent:${operation}`);
  }
  if (mapping.requiresShiftOperations) {
    require_(mapping.requiresShiftOperations.filter((operation) => opcodes.has(operation)).length >= 2, 'shift-operations-not-emitted');
  }
  if (mapping.requiresDefinedDivideEdgeCases) {
    require_(bundles.some((bundle) => Array.isArray(bundle.metadata?.definedEdgeCases) && bundle.metadata.definedEdgeCases.includes('divide-by-zero')), 'defined-divide-edge-cases-not-modeled');
  }
  if (mapping.requiresPcRelativeAddressFormation) {
    const origins = new Set(bundles.map((bundle) => bundle.metadata?.valueOrigin).filter(Boolean));
    require_(origins.has('auipc-pc-relative') || origins.has('lui-upper-immediate'), 'global-address-formation-not-modeled');
    // Position-independent code must form the address relative to the PC.
    if (fixture.target === 'riscv64-lp64-pie') require_(origins.has('auipc-pc-relative'), 'pie-global-access-not-pc-relative');
  }
  if (mapping.requiresMixedInstructionWidths) {
    const widths = new Set(decoded.map((instruction) => Number(instruction.size)));
    require_(widths.has(2) && widths.has(4), 'compressed-and-uncompressed-mix-not-present');
  }
  if (mapping.requiresNoZeroRegisterWrite) {
    require_(!registerWrites.some((operation) => operation.register?.registerId === 'x0'), 'hardwired-zero-register-was-written');
    require_(bundles.some((bundle) => Array.isArray(bundle.metadata?.discardedHardwiredZeroWrites) && bundle.metadata.discardedHardwiredZeroWrites.includes('x0'))
      || registerReads.every((operation) => operation.register?.registerId !== 'x0'), 'hardwired-zero-register-modelled-as-storage');
  }
  if (mapping.requiresAbiId) require_(analysis?.abiId === mapping.requiresAbiId, `abi-plugin-not-selected:${mapping.requiresAbiId}`);
  return failures;
}

function firstDivergenceForBundle(bundle, decoded) {
  const instruction = decoded.find((item) => item.instructionId === bundle?.instructionId) ?? null;
  return {
    completeness: bundle?.completeness ?? null,
    instructionId: bundle?.instructionId ?? null,
    family: bundle?.metadata?.instructionFamily ?? instruction?.instructionFamily ?? null,
    mnemonic: instruction?.mnemonic ?? null,
    bytes: instruction ? Buffer.from(instruction.rawBytes || []).toString('hex') : null,
    address: instruction ? `0x${BigInt(instruction.address).toString(16)}` : null,
    unknownReason: bundle?.unknownEffects?.reason ?? null,
  };
}

test('Phase 6 mandatory RISC-V64 corpus traverses the shared semantic middle-end with independent decoder oracles', async () => {
  const categories = PROFILE.corpus.mandatoryCategories;
  assert.deepEqual(Object.keys(CATEGORY_MAP.categories).sort(), [...categories].sort(), 'category map and frozen profile must agree exactly');

  const corpus = buildPhase6VerificationCorpus();
  const digest = corpusDigest(corpus);
  const capstone = await createCapstoneRiscv64Session();
  const ledger = [];
  const safety = { unknownStoreFailures: 0, unknownCallFailures: 0, hiddenFallbacks: 0, provenanceLosses: 0, decoderMismatches: 0, capstoneDifferentialMismatches: 0 };

  try {
    for (const fixture of corpus.fixtures) {
      const oracle = parseLlvmObjdump(fixture.disassembly);
      const binaryId = createBinaryIdFromDigest(fixture.sha256);
      const sliceId = createSliceId({ binaryId, index: 0, architecture: 'riscv64' });
      for (const category of categories) {
        const mapping = CATEGORY_MAP.categories[category];
        const functionOracle = oracle.get(mapping.symbol);
        const row = {
          target: fixture.target,
          optimization: fixture.optimization,
          category,
          fixture: fixture.id,
          function: mapping.symbol,
          elfType: fixture.elfType,
          abiId: fixture.abiId,
          binaryHash: fixture.sha256,
          instructionCount: functionOracle?.instructions?.length ?? 0,
          decodeMismatchCount: null,
          capstoneDifferentialMismatchCount: null,
          completeness: null,
          pipelineStatus: 'NOT-PROVEN',
          firstDivergence: null,
          status: 'NOT-PROVEN',
        };
        if (!functionOracle?.instructions?.length) {
          row.status = 'BLOCKING-MISSING-FIXTURE';
          row.firstDivergence = { stage: 'fixture', expected: `symbol ${mapping.symbol}`, actual: 'missing from LLVM disassembly' };
          ledger.push(row);
          continue;
        }
        try {
          const raw = capstone.decodeRaw(functionOracle.bytes, functionOracle.address);
          const decoded = capstone.decode(functionOracle.bytes, functionOracle.address).map((instruction) => ({
            ...instruction,
            instructionId: createInstructionId({
              binaryId, sliceId,
              virtualAddress: instruction.address,
              decodeMode: 'rv64imc',
              decoderSemanticVersion: instruction.decoderSemanticVersion,
            }),
          }));

          // Oracle 1: LLVM's own boundaries and bytes.
          const decoderMismatches = [];
          if (decoded.length !== functionOracle.instructions.length) {
            decoderMismatches.push({ kind: 'instruction-count', expected: functionOracle.instructions.length, actual: decoded.length });
          }
          const compareCount = Math.min(decoded.length, functionOracle.instructions.length);
          for (let index = 0; index < compareCount; index += 1) {
            for (const mismatch of compareDecodedWithOracle(decoded[index], functionOracle.instructions[index])) decoderMismatches.push({ index, ...mismatch });
          }
          row.decodeMismatchCount = decoderMismatches.length;
          safety.decoderMismatches += decoderMismatches.length;
          if (decoderMismatches.length) {
            row.status = 'BLOCKING-PRODUCTION-DEFECT';
            row.firstDivergence = { stage: 'decode', expected: 'LLVM instruction boundary and bytes', actual: decoderMismatches[0] };
            ledger.push(row);
            continue;
          }

          // Oracle 2: Capstone's independently implemented structured operands.
          const differential = [];
          for (let index = 0; index < decoded.length; index += 1) {
            for (const mismatch of compareWithCapstoneOperands(decoded[index], raw[index]?.capstoneOperands)) {
              differential.push({ index, address: `0x${BigInt(decoded[index].address).toString(16)}`, ...mismatch });
            }
          }
          row.capstoneDifferentialMismatchCount = differential.length;
          safety.capstoneDifferentialMismatches += differential.length;
          if (differential.length) {
            row.status = 'BLOCKING-PRODUCTION-DEFECT';
            row.firstDivergence = { stage: 'decoder-differential', expected: 'Capstone structured operands agree with ISA field extraction', actual: differential[0] };
            ledger.push(row);
            continue;
          }

          const analysis = analyzeDecodedSemanticFunction({
            architecture: 'riscv64',
            platform: 'linux',
            abiId: fixture.abiId,
            binaryId,
            sliceId,
            decoderSemanticVersion: decoded[0].decoderSemanticVersion,
            instructions: decoded,
            name: mapping.symbol,
          });

          const counts = completenessCounts(analysis.pipeline.machineEffects);
          row.completeness = counts;
          row.pipelineStatus = 'executed';
          const nonExact = counts.partial + counts.unknown + counts.unsupported;
          if (nonExact > 0) {
            const first = analysis.pipeline.machineEffects.find((bundle) => !['exact', 'exact-with-intrinsic'].includes(bundle.completeness));
            row.status = 'BLOCKING-PRODUCTION-DEFECT';
            row.firstDivergence = { stage: 'MachineEffects', expected: 'exact effects for the frozen RV64IMC profile', actual: firstDivergenceForBundle(first, decoded) };
            ledger.push(row);
            continue;
          }

          const categoryProof = categoryFailures(category, mapping, { asm: functionOracle.instructions.map((i) => i.asm.toLowerCase()).join('\n'), analysis, decoded, fixture });
          if (categoryProof.length) {
            row.status = 'BLOCKING-MISSING-FIXTURE';
            row.firstDivergence = { stage: 'category-proof', expected: category, actual: categoryProof[0] };
            ledger.push(row);
            continue;
          }

          const provenance = provenanceFailures(analysis);
          safety.provenanceLosses += provenance.length;
          if (provenance.length) {
            row.status = 'BLOCKING-PRODUCTION-DEFECT';
            row.firstDivergence = { stage: 'provenance', expected: 'instruction evidence retained through MachineEffects, Semantic IR and SSA', actual: provenance[0] };
            ledger.push(row);
            continue;
          }

          const instrumentation = analysis.pipeline.instrumentation;
          if (instrumentation.unsupportedInstructionCount > 0) safety.hiddenFallbacks += instrumentation.unsupportedInstructionCount;
          const pipelineComplete = analysis.pipeline.cfg?.blocks?.length
            && analysis.pipeline.ssa?.definitions
            && analysis.pipeline.memorySsa?.definitions
            && analysis.pipeline.legacyV1?.compat?.projection === 'semantic-ir-v2-to-v1'
            && analysis.decompiler?.semantic === true
            && analysis.architectureId === 'riscv64'
            && instrumentation.v2Executed === true
            && instrumentation.provenanceLossCount === 0;
          if (!pipelineComplete) {
            row.status = 'BLOCKING-PRODUCTION-DEFECT';
            row.firstDivergence = {
              stage: 'full-pipeline',
              expected: 'CFG + SSA + MemorySSA + compat projection + shared decompiler',
              actual: {
                cfg: analysis.pipeline.cfg?.blocks?.length ?? 0,
                ssa: Boolean(analysis.pipeline.ssa?.definitions),
                memorySsa: Boolean(analysis.pipeline.memorySsa?.definitions),
                projection: analysis.pipeline.legacyV1?.compat?.projection ?? null,
                decompiler: analysis.decompiler?.semantic ?? false,
                architectureId: analysis.architectureId,
              },
            };
            ledger.push(row);
            continue;
          }

          row.status = 'PASS';
          ledger.push(row);
        } catch (error) {
          row.status = 'BLOCKING-PRODUCTION-DEFECT';
          row.firstDivergence = { stage: 'pipeline', expected: 'successful exact analysis', actual: String(error?.stack || error) };
          ledger.push(row);
        }
      }
    }
  } finally {
    capstone.close();
  }

  const totals = {
    mandatory: ledger.length,
    passed: ledger.filter((row) => row.status === 'PASS').length,
    blocked: ledger.filter((row) => row.status.startsWith('BLOCKING-')).length,
    notProven: ledger.filter((row) => row.status === 'NOT-PROVEN').length,
  };
  const expected = PROFILE.corpus.mandatoryTargets.length * PROFILE.corpus.mandatoryOptimizationLevels.length * categories.length;
  console.log(`P6_PIPELINE_LEDGER=${JSON.stringify({
    profileVersion: PROFILE.profileVersion,
    corpusId: corpus.corpusId,
    corpusDigest: digest,
    toolchain: { compiler: corpus.toolchain.compilerVersion, linker: corpus.toolchain.linkerVersion },
    source: corpus.source,
    fixtures: corpus.fixtures.map(({ bytes, disassembly, objectMetadata, path: fixturePath, ...fixture }) => fixture),
    totals,
    safety,
    ledger,
  })}`);

  assert.equal(totals.mandatory, expected, 'every mandatory tuple must be instantiated; absence is BLOCKING, never PASS');
  assert.equal(totals.blocked, 0, `Phase 6 first blocker: ${JSON.stringify(ledger.find((row) => row.status.startsWith('BLOCKING-')))}`);
  assert.equal(totals.notProven, 0);
  assert.equal(totals.passed, expected);
  assert.equal(safety.provenanceLosses, 0);
  assert.equal(safety.hiddenFallbacks, 0);
  assert.equal(safety.decoderMismatches, 0);
  assert.equal(safety.capstoneDifferentialMismatches, 0);
});
