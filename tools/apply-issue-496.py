from pathlib import Path

p=Path('js/il2cpp.js')
text=p.read_text()
start=text.index('export async function bindMethodAddresses(meta, opts) {')
end=text.index('\nasync function bindCodeGenModules(meta, ctx)',start)
new=r'''export async function bindMethodAddresses(meta, opts) {
  const o = opts || {};
  const regions = o.regions || [];
  const read = o.read;
  if (!meta || !meta.methods || !meta.methods.length || typeof read !== 'function') return { bound: 0, candidate: null };
  meta.warnings ||= [];
  const exec = regions.filter((r) => r.exec && r.size > 0n);
  const data = regions.filter((r) => !r.exec && !r.zerofill && r.size >= 16n && /__(const|data|data_const|rodata)/.test(r.section || ''));
  const inExec = (raw) => { let p = BigInt.asUintN(64, raw); p &= 0x00ffffffffffffffn; return exec.some((r) => p >= r.vmAddr && p < r.vmAddr + r.size) ? p : null; };
  const containing = (addr, bytes) => regions.find((r) => addr >= r.vmAddr && addr + BigInt(bytes) <= r.vmAddr + r.size);
  const scanLimit = o.scanLimit || 64 * 1024 * 1024;
  const context = { regions, data, exec, read, containing, inExec, scanLimit };

  // Codegen modules carry image-name and metadata-token/RID evidence, so they
  // are strictly stronger than a shape-only global method-pointer table. Try
  // this path first for every metadata version that exposes image records.
  const modern = await bindCodeGenModules(meta, context);
  if (modern.bound) {
    meta.methodBinding = { ...(meta.methodBinding || {}), verified: true, evidence: ['image-name','token-rid','executable-pointer'] };
    return { ...modern, preferred: 'codegen-modules' };
  }

  // A legacy table maps metadata method indexes directly, so the candidate
  // must cover the complete method-definition slot range. meta.methods may
  // omit malformed records; max(index)+1 is therefore safer than length.
  const expectedSlots = meta.methods.reduce((m, method) => Math.max(m, Number(method.index) + 1), 0);
  const maxLegacyCount = expectedSlots + Math.max(32, Math.ceil(expectedSlots * 0.01));
  const candidates = [];
  let scanned = 0;

  const registrationNeighbors = (dv, at, byteLength) => {
    let observed = 0, proven = 0;
    for (let pair = 1; pair <= 3; pair++) {
      const pos = at + pair * 16;
      if (pos + 16 > byteLength) break;
      observed++;
      const count64 = dv.getBigUint64(pos, true);
      const pointer = dv.getBigUint64(pos + 8, true) & 0x00ffffffffffffffn;
      if (count64 > 5_000_000n) continue;
      const count = Number(count64);
      if (count === 0) {
        if (pointer === 0n) proven++;
        continue;
      }
      if (containing(pointer, Math.min(count, 16) * 8)) proven++;
    }
    return { observed, proven };
  };

  for (const r of data) {
    if (scanned >= scanLimit) break;
    const want = Math.min(Number(r.size), scanLimit - scanned);
    const bytes = await Promise.resolve(read(r.vmAddr, want)).catch(() => null); scanned += want;
    if (!bytes || bytes.length < 48) continue;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 0; at + 48 <= bytes.length; at += 8) {
      const count64 = dv.getBigUint64(at, true);
      if (count64 < 1n || count64 > 5_000_000n) continue;
      const count = Number(count64);
      // Direct method.index -> table[index] binding is not trustworthy if the
      // table cannot cover every metadata method slot or has a large tail.
      if (count < expectedSlots || count > maxLegacyCount) continue;
      const table = dv.getBigUint64(at + 8, true) & 0x00ffffffffffffffn;
      const sampleCount = Math.min(count, 128);
      if (!containing(table, sampleCount * 8)) continue;
      const structure = registrationNeighbors(dv, at, bytes.length);
      if (structure.observed < 2 || structure.proven < 2) continue;
      const sample = await Promise.resolve(read(table, sampleCount * 8)).catch(() => null);
      if (!sample || sample.length < sampleCount * 8) continue;
      const sdv = new DataView(sample.buffer, sample.byteOffset, sample.byteLength);
      let executable = 0, nonzero = 0;
      for (let i = 0; i < sampleCount; i++) {
        const raw = sdv.getBigUint64(i * 8, true);
        if (raw) nonzero++;
        if (inExec(raw) != null) executable++;
      }
      const ratio = executable / Math.max(1, nonzero);
      if (nonzero < Math.min(16, sampleCount) || ratio < 0.95) continue;
      const coveragePenalty = Math.abs(count - expectedSlots) / Math.max(1, expectedSlots);
      candidates.push({
        addr: r.vmAddr + BigInt(at), table, count, ratio,
        structurePairs: structure.proven,
        score: ratio + structure.proven * 0.04 - coveragePenalty * 0.5,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || Number(a.addr - b.addr));
  const best = candidates[0], second = candidates[1];
  if (!best) {
    meta.warnings.push('Codegen moduleを検証した後も、構造証明できるlegacy Method→address表は見つかりませんでした。');
    return { bound: 0, candidate: null, modernTried: true, reason: 'no-proven-legacy-table' };
  }
  const margin = o.legacyAmbiguityMargin ?? 0.08;
  if (second && best.score - second.score < margin) {
    meta.warnings.push(`Legacy method pointer候補が曖昧です（上位差 ${Math.max(0,best.score-second.score).toFixed(3)}）。自動bindingしません。`);
    return { bound: 0, candidate: null, modernTried: true, reason: 'ambiguous-legacy-table', ambiguousCandidates: Math.min(candidates.length, 2) };
  }

  const tableBytes = await Promise.resolve(read(best.table, best.count * 8)).catch(() => null);
  if (!tableBytes || tableBytes.length < best.count * 8) return { bound: 0, candidate: null, modernTried: true, reason: 'legacy-table-unreadable' };
  const tdv = new DataView(tableBytes.buffer, tableBytes.byteOffset, tableBytes.byteLength);
  const resolved = [];
  for (const method of meta.methods) {
    if (method.index < 0 || method.index >= best.count) continue;
    const address = inExec(tdv.getBigUint64(method.index * 8, true));
    if (address != null) resolved.push({ method, address });
  }
  const minResolved = Math.min(8, meta.methods.length);
  const coverage = resolved.length / Math.max(1, meta.methods.length);
  if (resolved.length < minResolved || coverage < 0.5) {
    meta.warnings.push(`Legacy method pointer表の全体整合性が不足しています（${resolved.length}/${meta.methods.length}）。自動bindingしません。`);
    return { bound: 0, candidate: null, modernTried: true, reason: 'legacy-coverage-insufficient' };
  }

  for (const { method, address } of resolved) { method.address = address; method.binding = 'code-registration'; }
  const bound = resolved.length;
  meta.methodBinding = {
    kind: 'code-registration', bound, count: best.count, table: best.table,
    verified: true,
    evidence: ['slot-coverage','registration-neighbors','executable-pointer-ratio','unique-candidate'],
    executableRatio: best.ratio,
    structurePairs: best.structurePairs,
  };
  return { bound, candidate: best, modernTried: true, preferred: 'verified-legacy' };
}
'''
text=text[:start]+new+text[end:]
p.write_text(text)
