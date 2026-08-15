/* Conservative switch/jump-table structuring. Verified descriptors only. */

function hex(v) { return BigInt(v).toString(16).toUpperCase(); }
function labelForAddress(addr) { return `loc_${hex(addr)}`; }
function textOf(lines) { return (lines || []).map((l) => `${'    '.repeat(Math.max(0, l.indent || 0))}${l.text || ''}`).join('\n'); }

function addressForBlock(result, opts, block, index) {
  const b = result?.ir?.blocks?.[Number(block)];
  if (!b) return null;
  return index.addressByRow.get(b.startRow) ?? opts.addrOfRow?.(b.startRow) ?? null;
}

function normalizedCase(c, result, opts, index) {
  if (!c || c.value == null) return null;
  let address = c.address ?? c.target ?? null;
  if (address == null && c.block != null) address = addressForBlock(result, opts, c.block, index);
  if (address == null) return null;
  try { address = BigInt(address); } catch { return null; }
  return { value: c.value, address, label: labelForAddress(address) };
}

function insertionIndex(lines, row) {
  let i = lines.findIndex((l) => l?.row === row && /__asm\(["']br\s/i.test(l.text || ''));
  if (i >= 0) return { start: i, end: i + 1, indent: lines[i].indent || 1 };
  let last = -1;
  for (let n = 0; n < lines.length; n++) {
    const r = lines[n]?.row;
    if (r != null && r <= row) last = n;
  }
  if (last < 0) return null;
  const next = lines[last + 1];
  const indent = next?.kind === 'label' ? (next.indent || 1) + 1 : (lines[last].indent || 1);
  return { start: last + 1, end: last + 1, indent };
}

function caseLiteral(v) {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
  if (typeof v === 'string' && /^-?(?:0x[0-9a-f]+|\d+)$/i.test(v.trim())) return v.trim();
  return null;
}

function caseIdentity(literal) {
  try { return `n:${BigInt(literal).toString()}`; } catch { return null; }
}

function targetIndex(result, model) {
  const labels = new Set();
  for (const l of result.lines || []) {
    const m = String(l?.text || '').match(/^\s*(loc_[0-9A-Fa-f]+):\s*$/);
    if (m) labels.add(m[1].toUpperCase());
  }
  const rows = new Map();
  const addressByRow = new Map();
  for (const i of model?.instructions || []) {
    if (i?.address == null || i?.row == null) continue;
    try {
      const address = BigInt(i.address);
      rows.set(address.toString(), i.row);
      if (!addressByRow.has(i.row)) addressByRow.set(i.row, address);
    } catch { /* malformed instruction address */ }
  }
  return { labels, rows, addressByRow };
}

function materializeVerifiedLabels(result, index, addresses) {
  const missing = [];
  const pendingLabels = new Set();
  for (const addressValue of addresses) {
    const address = BigInt(addressValue);
    const label = labelForAddress(address);
    const key = label.toUpperCase();
    if (index.labels.has(key) || pendingLabels.has(key)) continue;
    const row = index.rows.get(address.toString());
    if (row == null) return false;
    missing.push({ address, label, row });
    pendingLabels.add(key);
  }
  if (!missing.length) return true;
  const targets = [...missing].sort((a, b) => a.row - b.row);
  const placements = [];
  let ti = 0;
  for (let li = 0; li < result.lines.length && ti < targets.length; li++) {
    const row = result.lines[li]?.row;
    if (row == null) continue;
    while (ti < targets.length && targets[ti].row <= row) placements.push({ ...targets[ti++], at: li });
  }
  const closing = result.lines.findIndex((l) => l?.kind === 'ctrl' && l.text === '}');
  if (closing < 0) return false;
  while (ti < targets.length) placements.push({ ...targets[ti++], at: closing });
  placements.sort((a, b) => b.at - a.at || b.row - a.row);
  for (const item of placements) {
    const nearby = result.lines[item.at];
    const indent = nearby?.kind === 'label' ? (nearby.indent || 1) : Math.max(1, nearby?.indent || 1);
    result.lines.splice(item.at, 0, { kind: 'label', indent, text: `${item.label}:`, row: item.row, addr: item.address, note: null });
    index.labels.add(item.label.toUpperCase());
  }
  return true;
}

export function structureKnownSwitches(result, model, opts = {}) {
  if (!result || !Array.isArray(result.lines)) return result;
  const descriptors = opts.switches || opts.jumpTables || model?.switches || model?.jumpTables || [];
  if (!Array.isArray(descriptors) || !descriptors.length) return result;
  const index = targetIndex(result, model);
  for (const sw of descriptors) {
    if (!sw || sw.row == null || !Array.isArray(sw.cases) || sw.cases.length < 2) continue;
    const cases = sw.cases.map((c) => normalizedCase(c, result, opts, index));
    if (cases.some((c) => !c)) continue;
    const values = cases.map((c) => caseLiteral(c.value));
    const identities = values.map(caseIdentity);
    if (values.some((v) => v == null) || identities.some((v) => v == null) || new Set(identities).size !== identities.length) continue;
    let defaultAddress = sw.defaultAddress ?? sw.defaultTarget ?? null;
    if (defaultAddress == null && sw.defaultBlock != null) defaultAddress = addressForBlock(result, opts, sw.defaultBlock, index);
    try { if (defaultAddress != null) defaultAddress = BigInt(defaultAddress); } catch { defaultAddress = null; }
    const allTargets = cases.map((c) => c.address);
    if (defaultAddress != null) allTargets.push(defaultAddress);
    if (!materializeVerifiedLabels(result, index, allTargets)) {
      result.warnings = [...(result.warnings || []), `Switch at row ${sw.row} was not structured because one or more case targets are not exact instruction addresses.`];
      continue;
    }
    const at = insertionIndex(result.lines, sw.row);
    if (!at) continue;
    const expr = String(sw.expr || sw.reg || 'switch_value');
    const repl = [{ kind: 'ctrl', indent: at.indent, text: `switch (${expr}) {`, row: sw.row, addr: null, note: null }];
    for (let i = 0; i < cases.length; i++) repl.push({ kind: 'ctrl', indent: at.indent + 1, text: `case ${values[i]}: goto ${cases[i].label};`, row: sw.row, addr: cases[i].address, note: null });
    if (defaultAddress != null) repl.push({ kind: 'ctrl', indent: at.indent + 1, text: `default: goto ${labelForAddress(defaultAddress)};`, row: sw.row, addr: defaultAddress, note: null });
    repl.push({ kind: 'ctrl', indent: at.indent, text: '}', row: sw.row, addr: null, note: null });
    result.lines.splice(at.start, at.end - at.start, ...repl);
    result.evidence = [...(result.evidence || []), { row: sw.row, address: sw.address ?? null, op: 'switch', reason: 'verified jump-table/switch descriptor', cases: cases.map((c, i) => ({ value: values[i], target: c.address })) }];
    result.pseudocode = textOf(result.lines);
    result.ctx = { ...(result.ctx || {}), structuredSwitches: (result.ctx?.structuredSwitches || 0) + 1 };
  }
  return result;
}
