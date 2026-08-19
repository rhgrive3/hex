/**
 * Runs the frozen Phase 8 corpus through the real production decompiler.
 *
 * This is the only Phase 8 driver. Both the baseline capture, the release
 * verifier and the contract tests go through it, so there is exactly one answer
 * to "what did the product produce for this function" and no lane can quietly
 * measure a different pipeline than the one that ships.
 *
 * It builds the same function model the assembler-level harnesses already use
 * and calls the public `decompile()` facade — never a decompiler internal — so
 * what is measured is the product path, not a convenient subset of it.
 */

import { decompile } from '../../../js/decompile.js';
import { parseOperands } from '../../../js/arm64.js';
import { semanticAbiAdapter } from '../../../js/analysis/semantic-function.js';
import { AAPCS64_ABI } from '../../../js/targets/abi/index.js';
import { stableDigest } from '../../../js/core/identity/index.js';

import { loadCorpus } from './build-corpus.mjs';

const ABI_ADAPTER = semanticAbiAdapter(AAPCS64_ABI);

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
  return { kind: /^ld/.test(name) ? 'load' : 'store', size, stack: memory.base?.cls === 'sp' || memory.base?.num === 29 };
}

/** Builds the function model the decompiler consumes from frozen assembly text. */
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
    raw.push({ row: row++, mnemonic: match[1].toLowerCase(), operands: match[2].trim() });
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
      ...item, ops, address: addressOfRow(item.row),
      isReturn: mnemonic === 'ret', isBranch: branch, isConditional: conditional,
      isCall: mnemonic === 'bl' || mnemonic === 'blr',
      branchTarget: targetRow == null ? null : addressOfRow(targetRow),
      callTarget: null,
      memory: memoryInfo(mnemonic, ops),
      reads: [], writes: [], data: false,
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
    return { startRow: start, endRow: end, rows: Array.from({ length: end - start + 1 }, (_unused, offset) => start + offset) };
  });
  return { name, instructions, basicBlocks, semantic: [], calls: [] };
}

/**
 * Decompiles one frozen corpus entry through the product facade.
 *
 * The time budget is generous and fixed. A budget that varies with machine speed
 * would make `degraded` a property of the runner rather than of the function,
 * and degraded output is a completeness state Phase 8 has to measure honestly.
 */
export function decompileEntry(entry, { decompilerTimeBudgetMs = 400, index = 0, deterministicTransforms = true } = {}) {
  const model = modelFromAssembly(entry.assembly, entry.function, 0x100000n + BigInt(index) * 0x10000n);
  if (!model) return { id: entry.id, failure: 'assembly could not be parsed into a function model' };
  const rowOfAddress = new Map(model.instructions.map((instruction) => [instruction.address.toString(), instruction.row]));
  try {
    const result = decompile(model, {
      name: entry.function,
      addr: model.instructions[0].address,
      rowOfAddress: (address) => rowOfAddress.get(address?.toString()) ?? null,
      abiAdapter: ABI_ADAPTER,
      decompilerTimeBudgetMs,
      // Quality measurement runs work-bounded, not clock-bounded. The clock
      // valve is a responsiveness guard; leaving it on would make the baseline a
      // measurement of the CI runner's speed.
      deterministicTransforms,
    });
    return { id: entry.id, result };
  } catch (error) {
    return { id: entry.id, failure: error?.message || String(error) };
  }
}

/**
 * The observable shape of one decompilation.
 *
 * Only fields that are deterministic across runs are included. Elapsed times and
 * budget-derived flags are excluded on purpose: a baseline that encoded them
 * would fail on a slower machine for reasons that have nothing to do with
 * decompiler quality.
 */
export function observationOf(entry, outcome) {
  if (outcome.failure) return { id: entry.id, failure: outcome.failure };
  const result = outcome.result;
  const metrics = result?.metrics ?? {};
  return {
    id: entry.id,
    function: entry.function,
    optimization: entry.optimization,
    semantic: !!result?.semantic,
    pseudocode: result?.pseudocode ?? '',
    lineCount: Array.isArray(result?.lines) ? result.lines.length : 0,
    // Provenance: how many printed nodes still carry a source mapping, and the
    // exact set of addresses they map to. `provenanceLossCount = 0` is a Phase 8
    // hard-zero exit gate, so the address set is compared, not just the count.
    sourceMappedNodes: Array.isArray(result?.sourceMap) ? result.sourceMap.length : 0,
    provenanceDigest: stableDigest((result?.lines ?? []).map((line) => ({
      kind: line?.kind ?? null,
      addresses: (line?.source?.addresses ?? []).map((address) => String(address)),
      rows: (line?.source?.rows ?? []).map((row) => Number(row)),
    }))),
    // Whether the existing rewrite engine ran out of its time budget on this
    // function. It is recorded because the two counters below are only
    // meaningful when it is false: the rewrite fixed point is bounded by
    // wall-clock time, so a saturated function reports a different count on
    // every run. That is a pre-existing determinism defect, owned by P8-1
    // (`transformDeterminismFailureCount = 0`), not something to average away.
    budgetExceeded: metrics.rewriteBudgetExceeded ?? null,
    readability: {
      rawAssemblyFallbacks: metrics.rawAssemblyFallbacks ?? null,
      gotos: metrics.gotos ?? null,
      temporaries: metrics.temporaries ?? null,
      redundantCasts: metrics.redundantCasts ?? null,
      rewrittenExpressions: metrics.rewrittenExpressions ?? null,
      structured: metrics.structured ?? null,
    },
    prototypeArity: Array.isArray(result?.prototype?.parameters) ? result.prototype.parameters.length : null,
    highVariableGroups: Array.isArray(result?.highVariables?.groups) ? result.highVariables.groups.length : null,
    aggregateLayouts: Array.isArray(result?.aggregateLayouts) ? result.aggregateLayouts.length : null,
    phase8: result?.phase8 == null ? null : {
      status: result.phase8.status,
      published: result.phase8.published,
      completeness: result.phase8.completeness,
      transformCount: result.phase8.transformCount,
      invalidated: [...result.phase8.invalidated],
      registryDigest: result.phase8.registryDigest,
      publicationDigest: result.phase8.publicationDigest,
    },
  };
}

/** Runs the whole frozen corpus and returns one deterministic observation each. */
export function observeCorpus({ corpus = loadCorpus(), decompilerTimeBudgetMs = 400, deterministicTransforms = true } = {}) {
  return corpus.functions.map((entry, index) => observationOf(entry, decompileEntry(entry, { decompilerTimeBudgetMs, index, deterministicTransforms })));
}
