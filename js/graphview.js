/* Canonical CFG presentation seam.
 * Rendering/pan-zoom/call-graph behavior stays byte-for-byte in graphview-base.js.
 * Only the CFG adapter is overridden when a presentation-only Semantic-v2 model
 * carries the canonical CFG. Edge truth comes from that CFG, never mnemonic
 * re-inference. */
import { cfgGraph as legacyCfgGraph } from './graphview-base.js';

export * from './graphview-base.js';

function bigint(value) {
  if (value == null) return null;
  try { return BigInt(value); } catch { return null; }
}

function originAddress(origin) {
  if (!origin || typeof origin !== 'object') return null;
  const candidates = [
    origin.address,
    origin.virtualAddress,
    origin.vmAddress,
    origin.virtualRange?.start,
    origin.addressRange?.start,
    origin.addresses?.[0],
  ];
  for (const candidate of candidates) {
    const value = bigint(candidate);
    if (value != null) return value;
  }
  return null;
}

function instructionAddress(inst) {
  return bigint(inst?.address) ?? originAddress(inst?.origin) ?? originAddress(inst?.extra?.origin);
}

function compactSemanticLine(inst) {
  const mnemonic = String(inst?.mnemonic ?? '').trim();
  const operands = String(inst?.operands ?? '').trim();
  if (mnemonic) return `${mnemonic}${operands ? ` ${operands}` : ''}`;
  const op = String(inst?.op ?? inst?.kind ?? 'semantic').trim();
  const sub = String(inst?.sub ?? '').trim();
  return sub ? `${op}.${sub}` : op;
}

function edgeStyle(kind) {
  switch (kind) {
    case 'conditional-true': return { kind:'true', label:'成り立つ' };
    case 'conditional-false': return { kind:'false', label:'成り立たない' };
    case 'exception': return { kind:'jump', label:'例外' };
    case 'indirect-candidate': return { kind:'jump', label:'間接候補' };
    case 'unknown': return { kind:'jump', label:'未確定' };
    case 'call': return { kind:'call', label:'呼び出し' };
    case 'tail-call': return { kind:'call', label:'末尾呼び出し' };
    default: return { kind:'jump', label:null };
  }
}

function canonicalCfgGraph(model, cfg, opts = {}) {
  const legacyBlocks = model?.blocks || [];
  const bySemanticId = new Map(legacyBlocks.map((block) => [String(block.semanticBlockId), block]));
  const byCfgId = new Map((cfg.blocks || []).map((block) => [String(block.id), block]));
  const blockIndex = new Map((cfg.blocks || []).map((block, index) => [String(block.id), index]));
  const provenBackEdges = new Set((model?.backEdges || []).map((edge) => `${edge.from}:${edge.to}`));

  const nodes = (cfg.blocks || []).map((block, index) => {
    const compat = bySemanticId.get(String(block.id)) ?? legacyBlocks[index] ?? null;
    const insts = compat?.insts || [];
    const addr = instructionAddress(insts[0])
      ?? originAddress(compat?.origin)
      ?? (String(block.id) === String(cfg.entryBlockId) ? bigint(model?.startAddress) : null);
    const lines = insts.slice(0, 24).map(compactSemanticLine).filter(Boolean);
    if (!lines.length && Array.isArray(compat?.semanticNodeIds)) {
      lines.push(`${compat.semanticNodeIds.length} semantic node${compat.semanticNodeIds.length === 1 ? '' : 's'}`);
    }
    const isLoopHeader = compat?.isLoopHeader === true;
    return {
      id: String(block.id),
      title: (addr != null ? `0x${addr.toString(16).toUpperCase()}` : String(block.id))
        + (isLoopHeader ? '  ← ここへ戻ってくる' : ''),
      lines,
      kind: isLoopHeader ? 'loop' : (String(block.id) === String(cfg.entryBlockId) ? 'entry' : ''),
      addr,
      onTap: opts.onNode && addr != null ? () => opts.onNode(compat ?? block, addr) : null,
    };
  });

  const edges = [];
  for (const source of cfg.blocks || []) {
    const sourceId = String(source.id);
    const sourceCompat = bySemanticId.get(sourceId) ?? legacyBlocks[blockIndex.get(sourceId)] ?? null;
    for (const successor of source.successors || []) {
      const targetId = String(successor.to);
      if (!byCfgId.has(targetId)) continue;
      const targetCompat = bySemanticId.get(targetId) ?? legacyBlocks[blockIndex.get(targetId)] ?? null;
      const style = edgeStyle(successor.kind);
      const back = sourceCompat && targetCompat
        && provenBackEdges.has(`${sourceCompat.endRow}:${targetCompat.startRow}`);
      edges.push({
        from:sourceId,
        to:targetId,
        kind:back ? 'back' : style.kind,
        label:back ? null : style.label,
      });
    }
  }
  return { nodes, edges };
}

export function cfgGraph(model, opts) {
  const cfg = model?.__canonicalCfg ?? null;
  if (!cfg || !Array.isArray(cfg.blocks)) return legacyCfgGraph(model, opts);
  return canonicalCfgGraph(model, cfg, opts || {});
}
