/**
 * Runs the frozen Phase 8 corpus through the real product decompiler paths.
 *
 * ARM64 keeps the historical public `decompile()` facade over frozen assembly.
 * x86-64/RISC-V64 freeze real machine bytes, decode them with Hex's shipped
 * Capstone artifact, then use the existing target lifter + shared Semantic
 * IR/CFG/SSA/MemorySSA pipeline and the public semantic decompiler facade.
 * No architecture is represented by another architecture's parser or labels.
 */

import { decompile } from '../../../js/decompile.js';
import { parseOperands } from '../../../js/arm64.js';
import { semanticAbiAdapter } from '../../../js/analysis/semantic-function.js';
import { AAPCS64_ABI } from '../../../js/targets/abi/index.js';
import { createX86DecodedInstruction, X86_DECODER_SEMANTIC_VERSION } from '../../../js/targets/architecture/x86_64/decoded-instruction.js';
import { createRiscv64DecodedInstruction, RISCV64_DECODER_SEMANTIC_VERSION } from '../../../js/targets/architecture/riscv64/decoded-instruction.js';
import { stableDigest } from '../../../js/core/identity/index.js';
import { createCapstoneX86Session } from '../../../tests/phase5/helpers/capstone-session.mjs';
import { createCapstoneRiscv64Session } from '../../../tests/phase6/helpers/capstone-session.mjs';

import { loadCorpus } from './build-corpus.mjs';
import { decompileDecodedProductFunction } from './decoded-function-adapter.mjs';

const ABI_ADAPTER = semanticAbiAdapter(AAPCS64_ABI);
const X86_SESSION = await createCapstoneX86Session();
const RISCV_SESSION = await createCapstoneRiscv64Session();
let sessionsClosed = false;
function closeSessions() {
  if (sessionsClosed) return;
  sessionsClosed = true;
  try { X86_SESSION.close(); } catch { /* best effort */ }
  try { RISCV_SESSION.close(); } catch { /* best effort */ }
}
process.once('exit', closeSessions);

function codeText(line) { return String(line || '').replace(/\/\/.*$/, '').trim(); }

function memoryInfo(mnemonic, operands) {
  const name = String(mnemonic).toLowerCase();
  if (!/^(?:ld|st)/.test(name)) return null;
  const memory = operands.find((operand) => operand?.k === 'mem');
  if (!memory) return null;
  const first = operands.find((operand) => operand?.k === 'reg');
  let size = Math.max(1, Number(first?.bits || 64) / 8);
  if (/b$/.test(name) || /rb$/.test(name)) size = 1;
  else if (/h$/.test(name) || /rh$/.test(name)) size = 2;
  else if (/sw$/.test(name)) size = 4;
  if (/^(?:ldp|stp|ldnp|stnp)/.test(name)) size *= 2;
  return { kind:/^ld/.test(name) ? 'load' : 'store', size, stack:memory.base?.cls === 'sp' || memory.base?.num === 29 };
}

export function modelFromAssembly(assembly, name, baseAddress = 0x100000n) {
  const raw = [];
  const labels = new Map();
  let row = 0;
  for (const line of String(assembly).split(/\r?\n/)) {
    const text = codeText(line);
    if (!text) continue;
    const label = /^(\.L[\w.$]+):/.exec(text);
    if (label) { labels.set(label[1], row); continue; }
    if (text.startsWith('.') || text.startsWith('//') || text.startsWith('#')) continue;
    const match = /^([A-Za-z][\w.]*)\s*(.*)$/.exec(text);
    if (!match) continue;
    raw.push({ row:row++, mnemonic:match[1].toLowerCase(), operands:match[2].trim() });
  }
  if (raw.length === 0) return null;

  const addressOfRow = (value) => baseAddress + BigInt(value) * 4n;
  const instructions = raw.map((item) => {
    const ops = parseOperands(item.operands);
    const mnemonic = item.mnemonic;
    const targetText = item.operands.split(',').at(-1)?.trim();
    const targetRow = labels.get(targetText);
    const conditional = /^b\.[a-z]{2}$/.test(mnemonic) || /^(?:cbz|cbnz|tbz|tbnz)$/.test(mnemonic);
    const branch = mnemonic === 'b' || mnemonic === 'br' || conditional;
    return {
      ...item,
      ops,
      address:addressOfRow(item.row),
      isReturn:mnemonic === 'ret',
      isBranch:branch,
      isConditional:conditional,
      isCall:mnemonic === 'bl' || mnemonic === 'blr',
      branchTarget:targetRow == null ? null : addressOfRow(targetRow),
      callTarget:null,
      memory:memoryInfo(mnemonic, ops),
      reads:[], writes:[], data:false,
    };
  });

  const starts = new Set([0]);
  for (const instruction of instructions) {
    if (instruction.branchTarget != null) starts.add(Number((instruction.branchTarget - baseAddress) / 4n));
    if ((instruction.isBranch || instruction.isReturn) && instruction.row + 1 < instructions.length) starts.add(instruction.row + 1);
  }
  const sorted = [...starts].filter((value) => value >= 0 && value < instructions.length).sort((left, right) => left - right);
  const basicBlocks = sorted.map((start, index) => {
    const end = (sorted[index + 1] ?? instructions.length) - 1;
    return { startRow:start, endRow:end, rows:Array.from({ length:end - start + 1 }, (_unused, offset) => start + offset) };
  });
  return { name, instructions, basicBlocks, semantic:[], calls:[] };
}

function bytesOf(entry) {
  if (entry.representation !== 'machine-bytes' || typeof entry.bytes !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(entry.bytes)) {
    throw new TypeError(`phase8 corpus: invalid machine bytes for ${entry.id}`);
  }
  return Uint8Array.from(Buffer.from(entry.bytes, 'hex'));
}

function decodedCoverage(instructions, expectedBytes) {
  return (instructions || []).reduce((total, instruction) => total + Number(instruction.length ?? instruction.size ?? 0), 0) === expectedBytes;
}

function decodedFor(entry, baseAddress) {
  const bytes = bytesOf(entry);
  if (entry.architectureId === 'x86_64') {
    const raw = X86_SESSION.decode(bytes, baseAddress);
    if (!decodedCoverage(raw, bytes.length)) throw new Error(`phase8 corpus: x86_64 decoder did not cover all bytes for ${entry.id}`);
    return {
      instructions:raw.map((instruction, index) => createX86DecodedInstruction({
        ...instruction,
        instructionId:`phase8:${entry.id}:${index}`,
      })),
      decoderSemanticVersion:X86_DECODER_SEMANTIC_VERSION,
      mode:'long-64',
    };
  }
  if (entry.architectureId === 'riscv64') {
    const raw = RISCV_SESSION.decode(bytes, baseAddress);
    if (!decodedCoverage(raw, bytes.length)) throw new Error(`phase8 corpus: riscv64 decoder did not cover all bytes for ${entry.id}`);
    return {
      instructions:raw.map((instruction, index) => createRiscv64DecodedInstruction({
        ...instruction,
        instructionId:`phase8:${entry.id}:${index}`,
      })),
      decoderSemanticVersion:RISCV64_DECODER_SEMANTIC_VERSION,
      mode:'rv64imc',
    };
  }
  throw new TypeError(`phase8 corpus: unsupported machine-byte architecture ${entry.architectureId}`);
}

export function decompileEntry(entry, { decompilerTimeBudgetMs = 30000, index = 0, deterministicTransforms = true, phase8Optimize = true } = {}) {
  const baseAddress = 0x100000n + BigInt(index) * 0x10000n;
  try {
    if (entry.architectureId === 'arm64') {
      if (entry.representation !== 'assembly') return { id:entry.id, failure:'arm64 corpus entry is not frozen assembly' };
      const model = modelFromAssembly(entry.assembly, entry.function, baseAddress);
      if (!model) return { id:entry.id, failure:'assembly could not be parsed into a function model' };
      const rowOfAddress = new Map(model.instructions.map((instruction) => [instruction.address.toString(), instruction.row]));
      const result = decompile(model, {
        name:entry.function,
        addr:model.instructions[0].address,
        rowOfAddress:(address) => rowOfAddress.get(address?.toString()) ?? null,
        abiAdapter:ABI_ADAPTER,
        decompilerTimeBudgetMs,
        deterministicTransforms,
        phase8Optimize,
      });
      return { id:entry.id, result };
    }

    const decoded = decodedFor(entry, baseAddress);
    const result = decompileDecodedProductFunction({
      architecture:entry.architectureId,
      platform:'linux',
      name:entry.function,
      instructions:decoded.instructions,
      decoderSemanticVersion:decoded.decoderSemanticVersion,
      mode:decoded.mode,
      binaryId:`phase8-corpus:${entry.id}`,
      sliceId:`${entry.architectureId}:${entry.optimization}`,
      dataEndianness:'little',
      instructionEndianness:'little',
    }, { decompilerTimeBudgetMs, deterministicTransforms, phase8Optimize });
    return { id:entry.id, result };
  } catch (error) {
    return { id:entry.id, failure:error?.message || String(error) };
  }
}

export function observationOf(entry, outcome) {
  if (outcome.failure) return { id:entry.id, architectureId:entry.architectureId, failure:outcome.failure };
  const result = outcome.result;
  const metrics = result?.metrics ?? {};
  return {
    id:entry.id,
    architectureId:entry.architectureId,
    function:entry.function,
    optimization:entry.optimization,
    semantic:!!result?.semantic,
    pseudocode:result?.pseudocode ?? '',
    lineCount:Array.isArray(result?.lines) ? result.lines.length : 0,
    sourceMappedNodes:Array.isArray(result?.sourceMap) ? result.sourceMap.length : 0,
    provenanceDigest:stableDigest((result?.lines ?? []).map((line) => ({
      kind:line?.kind ?? null,
      addresses:(line?.source?.addresses ?? []).map((address) => String(address)),
      rows:(line?.source?.rows ?? []).map((row) => Number(row)),
    }))),
    budgetExceeded:metrics.rewriteBudgetExceeded ?? null,
    completeness:result?.ctx?.decompilerPipeline?.completeness ?? null,
    readability:{
      rawAssemblyFallbacks:metrics.rawAssemblyFallbacks ?? null,
      gotos:metrics.gotos ?? null,
      temporaries:metrics.temporaries ?? null,
      redundantCasts:metrics.redundantCasts ?? null,
      rewrittenExpressions:metrics.rewrittenExpressions ?? null,
      structured:metrics.structured ?? null,
    },
    prototypeArity:Array.isArray(result?.prototype?.parameters) ? result.prototype.parameters.length : null,
    highVariableGroups:Array.isArray(result?.highVariables?.groups) ? result.highVariables.groups.length : null,
    aggregateLayouts:Array.isArray(result?.aggregateLayouts) ? result.aggregateLayouts.length : null,
    phase8:result?.phase8 == null ? null : {
      status:result.phase8.status,
      enabledStages:[...(result.phase8.enabledStages ?? [])],
      published:result.phase8.published,
      completeness:result.phase8.completeness,
      transformCount:result.phase8.transformCount,
      produced:[...(result.phase8.produced ?? [])],
      invalidated:[...(result.phase8.invalidated ?? [])],
      registryDigest:result.phase8.registryDigest,
      publicationDigest:result.phase8.publicationDigest,
    },
    phase8Projection:result?.phase8Projection == null ? null : {
      version:result.phase8Projection.version,
      transformCount:result.phase8Projection.transformCount,
    },
  };
}

export function observeCorpus({ corpus = loadCorpus(), decompilerTimeBudgetMs = 5000, deterministicTransforms = true, phase8Optimize = true } = {}) {
  return corpus.functions.map((entry, index) => observationOf(entry, decompileEntry(entry, { decompilerTimeBudgetMs, index, deterministicTransforms, phase8Optimize })));
}

export { closeSessions };
