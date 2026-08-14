/* Source-provenance helpers shared by the decompiler UI and regression tests. */

function asBigInt(value) {
  if (value == null) return null;
  try { return BigInt(value); } catch { return null; }
}

function uniqueSortedBigInts(values) {
  const byText = new Map();
  for (const value of values || []) {
    const n = asBigInt(value);
    if (n != null) byText.set(n.toString(), n);
  }
  return [...byText.values()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

export function decompilerSourceAddresses(line) {
  const source = line?.source?.addresses;
  const values = Array.isArray(source) && source.length ? source : (line?.addr != null ? [line.addr] : []);
  return uniqueSortedBigInts(values);
}

export function decompilerSourceRows(line) {
  const source = line?.source?.rows;
  const values = Array.isArray(source) && source.length ? source : (line?.row != null ? [line.row] : []);
  return [...new Set(values.map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
}

export function primaryDecompilerAddress(line) {
  return decompilerSourceAddresses(line)[0] ?? null;
}

export function groupDecompilerAddresses(lineOrAddresses, step = 4n) {
  const addresses = Array.isArray(lineOrAddresses)
    ? uniqueSortedBigInts(lineOrAddresses)
    : decompilerSourceAddresses(lineOrAddresses);
  const groups = [];
  for (const address of addresses) {
    const last = groups[groups.length - 1];
    if (last && address === last.end + step) last.end = address;
    else groups.push({ start: address, end: address });
  }
  return groups;
}

function hex(address, digits = 0, prefix = '') {
  const body = BigInt(address).toString(16).toUpperCase();
  const visible = digits > 0 ? body.slice(-digits).padStart(digits, '0') : body;
  return prefix + visible;
}

function groupText(group, { digits = 6, prefix = '' } = {}) {
  const start = hex(group.start, digits, prefix);
  if (group.start === group.end) return start;
  return `${start}–${hex(group.end, digits, prefix)}`;
}

/** Compact, exact source ownership for the left gutter. Sparse ranges stay sparse. */
export function formatDecompilerSource(line, { digits = 6, maxGroups = 3 } = {}) {
  const groups = groupDecompilerAddresses(line);
  if (!groups.length) return '';
  const shown = groups.slice(0, Math.max(1, maxGroups));
  let text = shown.map((g) => groupText(g, { digits })).join(' · ');
  if (groups.length > shown.length) text += ` · +${groups.length - shown.length}`;
  return text;
}

/** Full source address text for copy/inspection; no address is silently hidden. */
export function fullDecompilerSourceText(line) {
  return groupDecompilerAddresses(line).map((g) => groupText(g, { digits: 0, prefix: '0x' })).join(', ');
}

export function hasSingleDecompilerInstruction(line) {
  return decompilerSourceAddresses(line).length === 1 && decompilerSourceRows(line).length <= 1;
}
