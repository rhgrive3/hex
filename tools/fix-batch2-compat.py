from pathlib import Path

p=Path('js/ir-core.js')
s=p.read_text()
old="""  if (a.baseRoot != null && b.baseRoot != null && a.baseRoot === b.baseRoot) {
    const sa = BigInt(a.size || 8), sb = BigInt(b.size || 8);
    return !(a.disp + sa <= b.disp || b.disp + sb <= a.disp);
  }
  return true;"""
new="""  const ar = a.baseRoot ?? a.base?.id ?? null;
  const br = b.baseRoot ?? b.base?.id ?? null;
  if (ar != null && br != null && ar === br) {
    const sa = BigInt(a.size || 8), sb = BigInt(b.size || 8);
    return !(a.disp + sa <= b.disp || b.disp + sb <= a.disp);
  }
  return true;"""
if old not in s:
    raise SystemExit('mayAlias compatibility anchor missing')
s=s.replace(old,new,1)
old="""    if (storeLoc.baseRoot != null && otherLoc.baseRoot != null && storeLoc.baseRoot === otherLoc.baseRoot) {
      return overlap(storeLoc.disp,sa,otherLoc.disp,sb);
    }
    return true;"""
new="""    const sr = storeLoc.baseRoot ?? storeLoc.base?.id ?? null;
    const otherRoot = otherLoc.baseRoot ?? otherLoc.base?.id ?? null;
    if (sr != null && otherRoot != null && sr === otherRoot) return overlap(storeLoc.disp,sa,otherLoc.disp,sb);
    return true;"""
if old not in s:
    raise SystemExit('store overlap compatibility anchor missing')
p.write_text(s.replace(old,new,1))
print('batch2 legacy alias compatibility applied')
