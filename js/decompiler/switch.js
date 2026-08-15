/*
 * Conservative switch/jump-table structuring.
 *
 * A jump table is only rendered as switch when an upstream parser provides a
 * verified descriptor. Unknown indirect branches are never guessed into cases.
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
  return { value: c.value, address, label: labelForAddress(address), bits: c.bits ?? c.width ?? null, signed: c.signed ?? null };
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

function canonicalCaseValue(v, sw = {}, c = {}) {
  let raw;
  try {
    if (typeof v === 'bigint') raw = v;
    else if (typeof v === 'number' && Number.isSafeInteger(v)) raw = BigInt(v);
    else if (typeof v === 'string' && /^-?(?:0x[0-9a-f]+|\d+)$/i.test(v.trim())) raw = BigInt(v.trim());
    else return null;
  } catch { return null; }
  const requestedBits = c.bits ?? c.width ?? sw.bits ?? sw.width ?? sw.valueBits ?? null;
  const numericBits = Number(requestedBits);
  const bits = Number.isInteger(numericBits) && numericBits > 0 && numericBits <= 128 ? numericBits : null;
  const signed = c.signed ?? sw.signed ?? null;
  const canonicalBits = bits ? BigInt.asUintN(bits, raw) : raw;
  const literal = bits
    ? (signed === true ? BigInt.asIntN(bits, raw) : BigInt.asUintN(bits, raw)).toString()
    : raw.toString();
  return { key:`${bits || 'integer'}:${canonicalBits}`, literal, bits, signed };
}

function rowForAddress(model, address) {
  const a = BigInt(address).toString();
  const insn = (model?.instructions || []).find((i) => {
    try { return i.address != null && BigInt(i.address).toString() === a; } catch { return false; }
  });
  return insn?.row ?? null;
}

/**
 * An indirect target can be absent from the ordinary reachable CFG even though
 * a verified jump-table descriptor proves it is a case entry. In that one
 * situation we may materialize the label, but only when the target address is
 * also an exact instruction address in the current function. This never turns
 * an arbitrary BR target into a case.
 */
function ensureVerifiedTargetLabel(result, model, address) {
  const label = labelForAddress(address);
  if (labelSet(result.lines).has(label.toUpperCase())) return true;
  const row = rowForAddress(model, address);
  if (row == null) return false;

  let at = result.lines.findIndex((l) => l?.row != null && l.row >= row && l.kind !== 'sig');
  if (at < 0) {
    at = result.lines.findIndex((l) => l?.kind === 'ctrl' && l.text === '}');
    if (at < 0) return false;
  }
  const nearby = result.lines[at];
  const indent = nearby?.kind === 'label' ? (nearby.indent || 1) : Math.max(1, (nearby?.indent || 1) - (nearby?.kind === 'stmt' ? 0 : 0));
  result.lines.splice(at, 0, { kind: 'label', indent, text: `${label}:`, row, addr: BigInt(address), note: null });
  return true;
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
    const normalizedValues = cases.map((c) => canonicalCaseValue(c.value, sw, c));
    if (normalizedValues.some((v) => v == null)) continue;
    const seenValues = new Map();
    let duplicate = null;
    for (let i = 0; i < normalizedValues.length; i++) {
      const key = normalizedValues[i].key;
      if (seenValues.has(key)) { duplicate = { first:seenValues.get(key), second:i, key }; break; }
      seenValues.set(key, i);
    }
    if (duplicate) {
      result.warnings = [...(result.warnings || []), `Switch at row ${sw.row} descriptor conflict: duplicate case values after integer canonicalization (${duplicate.key}).`];
      result.evidence = [...(result.evidence || []), {
        row:sw.row, address:sw.address ?? null, op:'switch-conflict',
        reason:'duplicate case values after width-aware integer canonicalization',
        cases:cases.map((c, i) => ({ value:normalizedValues[i].literal, target:c.address })),
      }];
      continue;
    }
    const values = normalizedValues.map((v) => v.literal);

    let defaultAddress = sw.defaultAddress ?? sw.defaultTarget ?? null;
    if (defaultAddress == null && sw.defaultBlock != null) defaultAddress = addressForBlock(result, model, opts, sw.defaultBlock);
    try { if (defaultAddress != null) defaultAddress = BigInt(defaultAddress); } catch { defaultAddress = null; }

    const allTargets = cases.map((c) => c.address);
    if (defaultAddress != null) allTargets.push(defaultAddress);
    const targetLabelsProven = allTargets.every((address) => ensureVerifiedTargetLabel(result, model, address));
    if (!targetLabelsProven) {
      result.warnings = [...(result.warnings || []), `Switch at row ${sw.row} was not structured because one or more case targets are not exact instruction addresses.`];
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
