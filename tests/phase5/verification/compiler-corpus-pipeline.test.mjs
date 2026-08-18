import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createBinaryIdFromDigest, createInstructionId, createSliceId } from '../../../js/core/identity/index.js';
import { createX86DecodedInstruction } from '../../../js/targets/architecture/x86_64/decoded-instruction.js';
import { analyzeDecodedSemanticFunction } from '../../../js/targets/architecture/x86_64/semantic-function.js';
import { buildVerificationCorpus } from '../../../tools/validation/phase5/build-verification-corpus.mjs';
import { compareDecodedWithOracle, parseLlvmObjdump } from '../../../tools/validation/phase5/llvm-oracle.mjs';
import { createCapstoneX86Session } from '../helpers/capstone-session.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const frozen = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/phase5/corpus/manifest.json'), 'utf8'));
const categoryMap = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/phase5/verification/manifests/p5-6-category-map.json'), 'utf8'));

function platformFor(target) { return target === 'microsoft-x64-pe' ? 'windows' : 'linux'; }
function defaultAbiFor(target) { return target === 'microsoft-x64-pe' ? 'microsoft-x64' : 'sysv-amd64'; }
function targetId(target) { return typeof target === 'string' ? target : target.id; }

function normalizedInstructions(capstoneRows, fixture) {
  const binaryId = createBinaryIdFromDigest(fixture.sha256);
  const sliceId = createSliceId({ binaryId, index:0, architecture:'x86_64' });
  return capstoneRows.map((raw) => createX86DecodedInstruction({
    ...raw,
    instructionId:createInstructionId({
      binaryId,
      sliceId,
      virtualAddress:raw.address,
      decodeMode:'long-64',
      decoderSemanticVersion:raw.decoderSemanticVersion,
    }),
  }));
}

function completenessCounts(bundles) {
  const out = { exact:0, exactWithIntrinsic:0, partial:0, unknown:0, unsupported:0 };
  for (const bundle of bundles || []) {
    if (bundle.completeness === 'exact') out.exact++;
    else if (bundle.completeness === 'exact-with-intrinsic') out.exactWithIntrinsic++;
    else if (bundle.completeness === 'partial') out.partial++;
    else if (bundle.completeness === 'unknown') out.unknown++;
    else out.unsupported++;
  }
  return out;
}

function independentCategoryCheck(category, oracleFunction, analysis) {
  const bundles = analysis?.pipeline?.machineEffects || [];
  const families = new Set(bundles.map((bundle) => String(bundle.metadata?.instructionFamily || '').toLowerCase()));
  const controls = new Set(bundles.map((bundle) => bundle.controlEffect?.kind).filter(Boolean));
  const operations = bundles.flatMap((bundle) => bundle.operations || []);
  const memoryReads = operations.filter((operation) => operation.kind === 'memory-read');
  const memoryWrites = operations.filter((operation) => operation.kind === 'memory-write');
  const registerWrites = operations.filter((operation) => operation.kind === 'register-write');
  const asm = oracleFunction.instructions.map((instruction) => instruction.asm.toLowerCase()).join('\n');
  const checks = [];
  const requireCheck = (condition, code) => { if (!condition) checks.push(code); };

  switch (category) {
    case 'scalar-integer-arithmetic':
      requireCheck([...families].some((family) => ['add','sub','xor','and','or'].includes(family)), 'integer-arithmetic-not-emitted'); break;
    case 'signed-and-unsigned-comparison':
      requireCheck(families.has('cmp') || families.has('test'), 'comparison-not-emitted');
      requireCheck(/\b(?:set|cmov|j)[a-z]+\b/.test(asm), 'signed-unsigned-consumer-not-emitted'); break;
    case 'conditional-branch': requireCheck(controls.has('conditional-branch'), 'conditional-branch-not-emitted'); break;
    case 'loops':
      requireCheck(controls.has('conditional-branch'), 'loop-condition-not-emitted');
      requireCheck(oracleFunction.instructions.some((instruction) => /^j[a-z]+/i.test(instruction.mnemonic) && /0x[0-9a-f]+/i.test(instruction.operands)), 'loop-transfer-not-evidenced'); break;
    case 'switch-like-control-flow':
      requireCheck(/\bjmpq?\b|\bcmov[a-z]+\b|\bja\b|\btable/i.test(asm), 'switch-like-control-not-emitted'); break;
    case 'stack-locals-and-spills': requireCheck(memoryReads.length > 0 && memoryWrites.length > 0 && /\(%rbp\)|\(%rsp\)/i.test(asm), 'stack-memory-not-emitted'); break;
    case 'pointer-load-and-store': requireCheck(memoryReads.length > 0 && memoryWrites.length > 0, 'pointer-load-store-not-emitted'); break;
    case 'array-indexing': requireCheck(memoryReads.length > 0 && /,[1248]\)/.test(asm), 'scaled-index-not-emitted'); break;
    case 'structure-field-access': requireCheck(memoryReads.length > 0 && memoryWrites.length > 0, 'struct-field-access-not-emitted'); break;
    case 'direct-calls': requireCheck(controls.has('call') || /\bcallq?\b/.test(asm), 'direct-call-not-emitted'); break;
    case 'indirect-calls': requireCheck(/\bcallq?\s+\*/.test(asm), 'indirect-call-not-emitted'); break;
    case 'multiple-arguments': requireCheck(/\(%rsp\)|\(%rbp\)/.test(asm), 'stack-argument-access-not-emitted'); break;
    case 'return-values': requireCheck(controls.has('return'), 'return-not-emitted'); break;
    case 'partial-width-integer-operations': requireCheck(/%[a-d][lh]\b|%[er]?[a-d]x\b|%[er]?(?:si|di)\b|%r\d+[bwd]?\b/i.test(asm), 'partial-width-form-not-emitted'); break;
    case 'zero-and-sign-extension': requireCheck([...families].some((family) => ['movzx','movsx','movsxd'].includes(family)) || /\bmovz|\bmovs/i.test(asm), 'extension-not-emitted'); break;
    case 'shifts': requireCheck([...families].some((family) => ['shl','sal','shr','sar','rol','ror'].includes(family)), 'shift-not-emitted'); break;
    case 'multiplication-and-division': requireCheck([...families].some((family) => ['imul','mul','idiv','div'].includes(family)), 'mul-div-not-emitted'); break;
    case 'rip-relative-globals-and-pic-addressing': requireCheck(/\(%rip\)/i.test(asm), 'rip-relative-not-emitted'); break;
    case 'scalar-floating-point': requireCheck([...families].some((family) => /(?:ss|sd)$/.test(family)), 'scalar-fp-not-emitted'); break;
    case 'baseline-compiler-emitted-simd': requireCheck(registerWrites.some((operation) => /^ymm|^xmm/.test(operation.register?.registerId || '')) || /%xmm\d+/i.test(asm), 'simd-not-emitted'); break;
    case 'atomic-read-modify-write':
      requireCheck(memoryReads.some((operation) => operation.access?.atomic === true) && memoryWrites.some((operation) => operation.access?.atomic === true), 'atomic-rmw-not-proven');
      requireCheck(memoryReads.some((operation) => operation.access?.ordering === 'seq-cst') && memoryWrites.some((operation) => operation.access?.ordering === 'seq-cst'), 'seq-cst-not-proven'); break;
    case 'sysv-amd64-abi': requireCheck(analysis?.abiId === 'sysv-amd64', 'sysv-plugin-not-selected'); break;
    case 'microsoft-x64-abi': requireCheck(analysis?.abiId === 'microsoft-x64', 'microsoft-plugin-not-selected'); break;
    case 'variadic-abi-edge': requireCheck(memoryReads.length > 0, 'variadic-state-not-read'); break;
    default: checks.push('unmapped-category');
  }
  return checks;
}

function provenanceFailures(analysis) {
  const bundles = analysis?.pipeline?.machineEffects || [];
  const failures = [];
  for (const bundle of bundles) {
    const id = bundle.instructionId;
    const has = (origin) => origin?.instructionIds?.includes(id);
    if (!has(bundle.origin)) failures.push({ instructionId:id, stage:'MachineEffects' });
    if (!analysis.pipeline.semanticIr.nodes.some((node) => has(node.origin))) failures.push({ instructionId:id, stage:'Semantic IR' });
    if (!analysis.pipeline.ssa.definitions.some((definition) => has(definition.origin)) && bundle.operations?.some((operation) => ['register-write','value','flag-write'].includes(operation.kind))) failures.push({ instructionId:id, stage:'SSA' });
  }
  return failures;
}

test('P5-6 provenance audit follows canonical OriginSet instruction-evidence contract', () => {
  const instructionId = 'instruction_contract_probe';
  const base = {
    pipeline: {
      machineEffects:[{ instructionId, origin:{ instructionIds:[instructionId] }, operations:[] }],
      semanticIr:{ nodes:[{ origin:{ instructionIds:[instructionId] } }] },
      ssa:{ definitions:[] },
    },
  };
  assert.deepEqual(provenanceFailures(base), []);
  assert.deepEqual(provenanceFailures({
    pipeline:{
      ...base.pipeline,
      machineEffects:[{ instructionId, origin:{ instructionIds:[] }, operations:[] }],
    },
  }), [{ instructionId, stage:'MachineEffects' }]);
});

test('P5-6 mandatory 144-tuple compiler corpus traverses the full x86 semantic product with independent LLVM boundaries', async () => {
  const expectedCategories = frozen.mandatoryCategories;
  assert.equal(expectedCategories.length, 24);
  assert.deepEqual(Object.keys(categoryMap.categories).sort(), [...expectedCategories].sort());
  const result = buildVerificationCorpus();
  const capstone = await createCapstoneX86Session();
  const ledger = [];
  try {
    for (const fixture of result.fixtures) {
      const oracle = parseLlvmObjdump(fixture.disassembly);
      for (const category of expectedCategories) {
        const mapping = categoryMap.categories[category];
        const functionOracle = oracle.get(mapping.symbol);
        const row = {
          target:fixture.target,
          optimization:fixture.optimization,
          category,
          fixture:fixture.id,
          function:mapping.symbol,
          sourceHash:result.source.sha256,
          binaryHash:fixture.sha256,
          compilerIdentity:result.toolchain.compilerVersion,
          entry:functionOracle ? `0x${functionOracle.address.toString(16)}` : null,
          range:functionOracle ? [`0x${functionOracle.address.toString(16)}`, `0x${functionOracle.endAddress.toString(16)}`] : null,
          instructionCount:functionOracle?.instructions?.length ?? 0,
          decodeMismatchCount:null,
          completeness:null,
          pipelineStatus:'NOT-PROVEN',
          differentialResult:'NOT-PROVEN',
          firstDivergence:null,
          status:'NOT-PROVEN',
        };
        if (!functionOracle?.instructions?.length) {
          row.status = 'BLOCKING-MISSING-FIXTURE';
          row.firstDivergence = { stage:'fixture', expected:`symbol ${mapping.symbol}`, actual:'missing from LLVM disassembly' };
          ledger.push(row);
          continue;
        }
        try {
          const raw = capstone.decode(functionOracle.bytes, functionOracle.address);
          const normalized = normalizedInstructions(raw, fixture);
          const decoderMismatches = [];
          if (normalized.length !== functionOracle.instructions.length) decoderMismatches.push({ kind:'instruction-count', expected:functionOracle.instructions.length, actual:normalized.length });
          const compareCount = Math.min(normalized.length, functionOracle.instructions.length);
          for (let index = 0; index < compareCount; index++) {
            for (const mismatch of compareDecodedWithOracle(normalized[index], functionOracle.instructions[index])) decoderMismatches.push({ index, ...mismatch });
          }
          row.decodeMismatchCount = decoderMismatches.length;
          if (decoderMismatches.length) {
            row.status = 'BLOCKING-PRODUCTION-DEFECT';
            row.firstDivergence = { stage:'decode', expected:'LLVM instruction boundary/bytes/structured operand traits', actual:decoderMismatches[0] };
            ledger.push(row);
            continue;
          }
          const binaryId = createBinaryIdFromDigest(fixture.sha256);
          const sliceId = createSliceId({ binaryId, index:0, architecture:'x86_64' });
          const analysisAbiId = mapping.analysisAbiId || defaultAbiFor(fixture.target);
          const analysis = analyzeDecodedSemanticFunction({
            architecture:'x86_64',
            platform:platformFor(fixture.target),
            abiId:analysisAbiId,
            binaryId,
            sliceId,
            decoderSemanticVersion:normalized[0].decoderSemanticVersion,
            instructions:normalized,
            name:mapping.symbol,
            completeness:'complete',
          });
          const counts = completenessCounts(analysis.pipeline.machineEffects);
          row.completeness = counts;
          row.pipelineStatus = 'executed';
          const nonExact = counts.partial + counts.unknown + counts.unsupported;
          if (nonExact > 0) {
            const first = analysis.pipeline.machineEffects.find((bundle) => !['exact','exact-with-intrinsic'].includes(bundle.completeness));
            row.status = 'BLOCKING-PRODUCTION-DEFECT';
            row.firstDivergence = { stage:'MachineEffects', expected:'exact or justified exact-with-intrinsic', actual:{ completeness:first?.completeness, family:first?.metadata?.instructionFamily, address:first?.origin?.virtualRanges?.[0] ?? null } };
            ledger.push(row);
            continue;
          }
          const categoryFailures = independentCategoryCheck(category, functionOracle, analysis);
          if (categoryFailures.length) {
            row.status = 'BLOCKING-MISSING-FIXTURE';
            row.firstDivergence = { stage:'fixture-category-proof', expected:category, actual:categoryFailures[0] };
            ledger.push(row);
            continue;
          }
          const provenance = provenanceFailures(analysis);
          if (provenance.length) {
            row.status = 'BLOCKING-PRODUCTION-DEFECT';
            row.firstDivergence = { stage:'provenance', expected:'instruction evidence retained through required semantic stages', actual:provenance[0] };
            ledger.push(row);
            continue;
          }
          if (!analysis.pipeline.cfg?.blocks?.length || !analysis.pipeline.ssa?.definitions || !analysis.pipeline.memorySsa?.definitions || analysis.pipeline.legacyV1?.compat?.projection !== 'semantic-ir-v2-to-v1' || analysis.decompiler?.semantic !== true) {
            row.status = 'BLOCKING-PRODUCTION-DEFECT';
            row.firstDivergence = { stage:'full-pipeline', expected:'CFG+SSA+MemorySSA+compat+shared decompiler', actual:{ cfg:analysis.pipeline.cfg?.blocks?.length ?? 0, ssa:Boolean(analysis.pipeline.ssa?.definitions), memorySsa:Boolean(analysis.pipeline.memorySsa?.definitions), projection:analysis.pipeline.legacyV1?.compat?.projection ?? null, decompiler:analysis.decompiler?.semantic ?? false } };
            ledger.push(row);
            continue;
          }
          row.differentialResult = 'LLVM-boundary-match';
          row.status = 'PASS';
          ledger.push(row);
        } catch (error) {
          row.status = 'BLOCKING-PRODUCTION-DEFECT';
          row.firstDivergence = { stage:'pipeline', expected:'successful exact analysis', actual:String(error?.stack || error) };
          ledger.push(row);
        }
      }
    }
  } finally {
    capstone.close();
  }

  const totals = {
    mandatory:ledger.length,
    passed:ledger.filter((row) => row.status === 'PASS').length,
    failed:ledger.filter((row) => row.status === 'FAIL').length,
    blocked:ledger.filter((row) => row.status.startsWith('BLOCKING-')).length,
    notProven:ledger.filter((row) => row.status === 'NOT-PROVEN').length,
  };
  console.log(`P5_6_PIPELINE_LEDGER=${JSON.stringify({ productSha:process.env.P5_VERIFIED_PRODUCT_SHA || 'b4182b995b7abea85f328b973b03f9ae0719bef3', source:result.source, fixtures:result.fixtures.map(({ bytes, disassembly, objectMetadata, path:ignoredPath, ...fixture }) => fixture), totals, ledger })}`);
  assert.equal(totals.mandatory, 144);
  assert.equal(totals.blocked, 0, `P5-6 first blocker: ${JSON.stringify(ledger.find((row) => row.status.startsWith('BLOCKING-')))}`);
  assert.equal(totals.notProven, 0);
  assert.equal(totals.passed, 144);
});