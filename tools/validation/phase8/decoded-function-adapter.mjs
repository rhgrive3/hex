import { architecturePluginV2 } from '../../../js/targets/architecture/index.js';
import { resolveABIPlugin } from '../../../js/targets/abi/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../../../js/semantics/compat/index.js';
import { partitionDecodedFunction, semanticAbiAdapter } from '../../../js/analysis/semantic-function.js';
import { decompileSemantic, enhanceSemanticDecompilation } from '../../../js/decompile.js';

function addressOf(instruction) { return BigInt(instruction.address); }

function addressWidthBitsFor(plugin) {
  let descriptors = [];
  try { descriptors = plugin.registerFile() || []; } catch { descriptors = []; }
  const stack = descriptors.find((descriptor) => String(descriptor?.kind ?? '') === 'stack-pointer');
  const bits = Number(stack?.bits ?? 0);
  return Number.isSafeInteger(bits) && bits > 0 ? bits : 64;
}

function productModel(pipeline, decoded, name) {
  const decodedByInstructionId = new Map(pipeline.machineEffects.map((bundle, index) => [bundle.instructionId, decoded[index]]));
  const rows = new Map();
  for (const legacy of pipeline.legacyV1.instructions) {
    const candidates = (legacy.origin?.instructionIds || []).map((id) => decodedByInstructionId.get(id)).filter(Boolean);
    const instruction = candidates.sort((left, right) => addressOf(left) < addressOf(right) ? -1 : addressOf(left) > addressOf(right) ? 1 : 0)[0] ?? decoded[0];
    if (!rows.has(legacy.row)) rows.set(legacy.row, {
      row:legacy.row,
      address:legacy.address == null ? addressOf(instruction) : BigInt(legacy.address),
      size:Number(instruction.length ?? instruction.size),
      mn:String(instruction.mnemonic || instruction.instructionFamily || ''),
      ops:String(instruction.opStr || ''),
    });
  }
  for (const block of pipeline.legacyV1.blocks) {
    const proven = (block.insts || []).map((instruction) => instruction.address).filter((address) => address != null).map(BigInt)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)[0];
    if (proven == null) continue;
    const prior = rows.get(block.startRow);
    rows.set(block.startRow, { ...(prior || { row:block.startRow, size:0, mn:'', ops:'' }), address:proven });
  }
  const maximumRow = Math.max(0, ...rows.keys());
  return {
    name,
    instructions:Array.from({ length:maximumRow + 1 }, (_unused, row) => rows.get(row) ?? {
      row,
      address:addressOf(decoded[0]),
      size:0,
      mn:'',
      ops:'',
    }),
    switches:[],
    calls:[],
  };
}

/**
 * Measurement adapter for already-decoded non-ARM functions.
 *
 * It contains no instruction semantics. Target decoding/lifting, ABI selection,
 * Semantic IR/CFG/SSA/MemorySSA and decompilation all remain product modules.
 * This file only supplies the same function-model boundary the public decompiler
 * facade expects, which is why it is safe to overlay onto the pre-Phase-8 base
 * when re-capturing an expanded corpus baseline.
 */
export function decompileDecodedProductFunction(input, options = {}) {
  if (!Array.isArray(input?.instructions) || input.instructions.length === 0) throw new TypeError('phase8-measurement-decoded-instructions-required');
  const architectureId = String(input.architecture || '').toLowerCase();
  const plugin = architecturePluginV2(architectureId);
  if (!plugin || plugin.id !== architectureId) throw new TypeError(`phase8-measurement-architecture-unavailable:${architectureId}`);
  const abi = resolveABIPlugin({ architecture:architectureId, platform:input.platform || 'linux' });
  if (!abi?.supported || abi.architectureId !== architectureId) throw new TypeError(`phase8-measurement-abi-unavailable:${architectureId}`);
  const abiAdapter = semanticAbiAdapter(abi, input);
  const blocks = partitionDecodedFunction(input.instructions, plugin, { callPrototype:input.callPrototype ?? null });
  let defaultMode = null;
  try { defaultMode = plugin.modes()?.[0] ?? null; } catch { defaultMode = null; }
  const pipeline = buildSemanticV2CompatibilityPipeline({
    architecturePlugin:plugin,
    decoderSemanticVersion:String(input.decoderSemanticVersion),
    binaryId:String(input.binaryId),
    sliceId:String(input.sliceId),
    addressWidthBits:addressWidthBitsFor(plugin),
    mode:input.mode ?? defaultMode ?? 'default',
    entryBlockKey:blocks[0].key,
    blocks,
    abiAdapter,
    machineEffectsContext:{
      dataEndianness:input.dataEndianness ?? 'little',
      instructionEndianness:input.instructionEndianness ?? 'little',
    },
  }, { abiAdapter });
  const model = productModel(pipeline, input.instructions, input.name);
  const rowByAddress = new Map(model.instructions.filter((instruction) => instruction.size > 0)
    .map((instruction) => [BigInt(instruction.address).toString(), instruction.row]));
  const decompilerOptions = {
    ir:pipeline.legacyV1,
    abiAdapter,
    decoderSemanticVersion:String(input.decoderSemanticVersion),
    binaryId:String(input.binaryId),
    sliceId:String(input.sliceId),
    addr:addressOf(input.instructions[0]),
    name:input.name,
    functionPrototype:input.functionPrototype ?? null,
    rowOfAddress:(address) => rowByAddress.get(BigInt(address).toString()) ?? null,
    deterministicTransforms:options.deterministicTransforms === true,
    phase8Optimize:options.phase8Optimize === true,
    decompilerTimeBudgetMs:Number(options.decompilerTimeBudgetMs ?? 5000),
    phase8TimeBudgetMs:Number(options.phase8TimeBudgetMs ?? 250),
  };
  const raw = decompileSemantic(model, decompilerOptions);
  if (!raw) throw new Error('phase8-measurement-product-decompiler-produced-no-result');
  return enhanceSemanticDecompilation(raw, model, decompilerOptions);
}
