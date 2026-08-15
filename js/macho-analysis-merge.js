function namesOf(result) {
  if (Array.isArray(result?.names)) return result.names.map((x) => String(x ?? ''));
  if (typeof result?.names === 'string') return result.names ? result.names.split('\n') : [];
  return [];
}

function truthFallback(reason) {
  return { source:'BinaryImage', normalized:true, complete:false, reasons:[String(reason || 'normalized-macho-analysis-unavailable')] };
}

export function markMachOSymbolTruthIncomplete(result, reason) {
  return { ...result, symbolTruth: truthFallback(reason) };
}

export function mergeMachOAnalysisResults(legacy, normalized) {
  if (!legacy?.addrs) return normalized;
  if (!normalized?.addrs) return markMachOSymbolTruthIncomplete(legacy, 'normalized-macho-analysis-unavailable');
  const entries = new Map();
  const ingest = (result, authoritative) => {
    const names = namesOf(result);
    for (let i = 0; i < result.addrs.length; i++) {
      const addr = BigInt(result.addrs[i]), key = addr.toString();
      const next = {
        addr, name:names[i] || '', kind:Number(result.kinds?.[i] ?? 0), flag:Number(result.flags?.[i] ?? 0),
        provenance:result.nameProvenance?.[i] || null,
      };
      const current = entries.get(key);
      if (!current) { entries.set(key, next); continue; }
      current.flag ||= next.flag;
      if (authoritative && next.name && (next.kind === 2 || !current.name || current.kind === 0)) {
        current.name = next.name; current.kind = next.kind; current.provenance = next.provenance;
      }
    }
  };
  ingest(legacy, false); ingest(normalized, true);
  const sorted = [...entries.values()].sort((a,b) => a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0);
  const addrs = new BigUint64Array(sorted.length), kinds = new Uint8Array(sorted.length), flags = new Uint8Array(sorted.length);
  for (let i = 0; i < sorted.length; i++) { addrs[i] = sorted[i].addr; kinds[i] = sorted[i].kind; flags[i] = sorted[i].flag; }
  return {
    ...legacy, addrs, kinds, flags, names:sorted.map((x)=>x.name), nameProvenance:sorted.map((x)=>x.provenance),
    symbolCount:sorted.length,
    symbolTruth:normalized.symbolTruth || truthFallback('normalized-macho-completeness-unreported'),
    __transfer:[addrs.buffer, kinds.buffer, flags.buffer, legacy.funcs?.buffer].filter(Boolean),
  };
}
