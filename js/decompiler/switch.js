/*
 * Conservative switch/jump-table structuring.
 *
 * A jump table is only rendered as switch when an upstream parser provides a
 * verified descriptor whose case targets all correspond to labels that the
 * faithful CFG already emits. This layer never guesses table entries from an
 * arbitrary indirect branch.
 */

function hex(v) { return BigInt(v).toString(16).toUpperCase(); }
function labelForAddress(addr) { return `loc_${hex(addr)}`; }
function textOf(lines) { return (lines || []).map((l) => `${'    '.repeat(Math.max(0, l.indent || 0))}${l.text || ''}`).join('\n'); }

function addressForBlock(result, model, opts, block) {
  const b = result?.ir?.blocks?.[Number(block)];
  if (!b) return null;
  return model?.instructions?.find((i) => i.row === b.startRow)?.address
    ?? opts.addrOfRow?.(b.startRow)
    ?? null;
}

function normalizedCase(c, result, model, opts) {
  if (!c || c.value == null) return null;
  let address = c.address ?? c.target ?? null;
  if (address == null && c.block != null) address = addressForBlock(result, model, opts, c.block);
  if (address == null) return null;
  try { address = BigInt(address); } catch { return null; }
  return { value: c.value, address, label: labelForAddress(address) };
}

function labelSet(lines) {
  const out = new Set();
  for (const l of lines || []) {
    const m = String(l?.text || '').match(/^\s*(loc_[0-9A-Fa-f]+):\s*$/);
    if (m) out.add(m[1].toUpperCase());
  }
  return out;
}

function insertionIndex(lines, row) {
  // Prefer replacing the explicit indirect branch emitted by faithful mode.
  let i = lines.findIndex((l) => l?.row === row && /__asm\(["']br\s/i.test(l.text || ''));
  if (i >= 0) return { start: i, end: i + 1, indent: lines[i].indent || 1 };
  // Some renderers omit the BR statement but keep source-row annotations on
  // adjacent statements. Insert immediately after the last line preceding it.
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
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && /^-?(?:0x[0-9a-f]+|\d+)$/i.test(v.trim())) return v.trim();
  return null;
}

/**
 * Upgrade verified switch descriptors to source-like control flow while
 * retaining goto targets. Accepted descriptor fields:
 *   {row, expr|reg, cases:[{value,address|target|block}], defaultAddress|defaultTarget|defaultBlock}
 */
export function structureKnownSwitches(result, model, opts = {}) {
  if (!result || !Array.isArray(result.lines)) return result;
  const descriptors = opts.switches || opts.jumpTables || model?.switches || model?.jumpTables || [];
  if (!Array.isArray(descriptors) || !descriptors.length) return result;

  for (const sw of descriptors) {
    if (!sw || sw.row == null || !Array.isArray(sw.cases) || sw.cases.length < 2) continue;
    const cases = sw.cases.map((c) => normalizedCase(c, result, model, opts));
    if (cases.some((c) => !c)) continue;
    const values = cases.map((c) => caseLiteral(c.value));
    if (values.some((v) => v == null) || new Set(values).size !== values.length) continue;

    let defaultAddress = sw.defaultAddress ?? sw.defaultTarget ?? null;
    if (defaultAddress == null && sw.defaultBlock != null) defaultAddress = addressForBlock(result, model, opts, sw.defaultBlock);
    try { if (defaultAddress != null) defaultAddress = BigInt(defaultAddress); } catch { defaultAddress = null; }

    const labels = labelSet(result.lines);
    const required = cases.map((c) => c.label.toUpperCase());
    if (defaultAddress != null) required.push(labelForAddress(defaultAddress).toUpperCase());
    if (!required.every((l) => labels.has(l))) {
      result.warnings = [...(result.warnings || []), `Switch at row ${sw.row} was not structured because one or more case targets are not proven CFG labels.`];
      continue;
    }

    const at = insertionIndex(result.lines, sw.row);
    if (!at) continue;
    const expr = String(sw.expr || sw.reg || 'switch_value');
    const repl = [{ kind: 'ctrl', indent: at.indent, text: `switch (${expr}) {`, row: sw.row, addr: null, note: null }];
    for (let i = 0; i < cases.length; i++) {
      repl.push({ kind: 'ctrl', indent: at.indent + 1, text: `case ${values[i]}: goto ${cases[i].label};`, row: sw.row, addr: cases[i].address, note: null });
    }
    if (defaultAddress != null) {
      repl.push({ kind: 'ctrl', indent: at.indent + 1, text: `default: goto ${labelForAddress(defaultAddress)};`, row: sw.row, addr: defaultAddress, note: null });
    }
    repl.push({ kind: 'ctrl', indent: at.indent, text: '}', row: sw.row, addr: null, note: null });
    result.lines.splice(at.start, at.end - at.start, ...repl);
    result.evidence = [...(result.evidence || []), {
      row: sw.row, address: sw.address ?? null, op: 'switch',
      reason: 'verified jump-table/switch descriptor',
      cases: cases.map((c, i) => ({ value: values[i], target: c.address })),
    }];
    result.pseudocode = textOf(result.lines);
    result.ctx = { ...(result.ctx || {}), structuredSwitches: (result.ctx?.structuredSwitches || 0) + 1 };
  }
  return result;
}
