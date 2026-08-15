from pathlib import Path
p = Path(__file__).resolve().parents[1] / 'js/linkage.js'
s = p.read_text()
old = """  const dataRegions = (regions || []).filter((r) =>
    !r.exec && r.size > 0n && /__data|__bss|__common|__const|__cfstring|__objc_(ivar|const|data)/.test(r.section || ''));"""
new = """  const dataRegions = (regions || []).filter((r) =>
    !r.exec && (r.declaredSize ?? r.size ?? 0n) > 0n &&
    /__data|__bss|__common|__const|__cfstring|__objc_(ivar|const|data)/.test(r.section || ''));"""
if old not in s: raise RuntimeError('dataRegions pattern missing')
s = s.replace(old, new, 1)
old = """/** データ参照の多いアドレスを数え上げる。 */
function hotDataAddresses(program, dataRegions, limit, minRefs) {
  const counts = new Map();
  const inData = (addr) => dataRegions.find((r) => addr >= r.vmAddr && addr < r.vmAddr + r.declaredSize);
  const n = program.refCount || 0;
  const step = n > 400000 ? Math.ceil(n / 400000) : 1;   // 巨大なアプリでは間引く
  for (let i = 0; i < n; i += step) {
    const target = program.refTo[i];
    if (target == null) continue;
    const r = inData(target);
    if (!r) continue;
    const key = target.toString();
    if (!counts.has(key)) counts.set(key, { addr: target, refs: 0, region: r.name });
    counts.get(key).refs++;
  }
  return Array.from(counts.values())
    .filter((c) => c.refs >= minRefs)
    .sort((a, b) => b.refs - a.refs)
    .slice(0, limit);
}"""
new = """/** データ参照の多いアドレスを正確に数え上げる。 */
function hotDataAddresses(program, dataRegions, limit, minRefs) {
  const counts = new Map();
  // Regions are few; sorting lets us reject most non-data refs without allocating
  // per-reference objects. Unlike the old fixed-phase sampler, every xref counts.
  const ranges = dataRegions
    .map((r) => ({ r, lo: r.vmAddr, hi: r.vmAddr + (r.declaredSize ?? r.size ?? 0n) }))
    .filter((x) => x.hi > x.lo)
    .sort((a, b) => a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0);
  const inData = (addr) => {
    let lo = 0, hi = ranges.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const x = ranges[mid];
      if (addr < x.lo) hi = mid - 1;
      else if (addr >= x.hi) lo = mid + 1;
      else return x.r;
    }
    return null;
  };
  const n = program.refCount || 0;
  for (let i = 0; i < n; i++) {
    const target = program.refTo[i];
    if (target == null) continue;
    const r = inData(target);
    if (!r) continue;
    const key = target.toString();
    const hit = counts.get(key);
    if (hit) hit.refs++;
    else counts.set(key, { addr: target, refs: 1, region: r.name, complete: true });
  }
  return Array.from(counts.values())
    .filter((c) => c.refs >= minRefs)
    .sort((a, b) => b.refs - a.refs || (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0))
    .slice(0, limit);
}"""
if old not in s: raise RuntimeError('hotDataAddresses pattern missing')
s = s.replace(old, new, 1)
p.write_text(s)
print('linkage fixes applied')
