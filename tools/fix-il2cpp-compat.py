from pathlib import Path
p=Path('js/il2cpp.js')
s=p.read_text()
old="const covered=rids.filter((rid)=>rid<c.count).length,tokenCoverage=covered/Math.max(1,rids.length),maxRid=rids.length?Math.max(...rids):-1;"
new="const covered=rids.filter((rid)=>rid<c.count).length,tokenCoverage=covered/Math.max(1,Math.min(rids.length,c.count)),maxRid=rids.length?Math.max(...rids):-1;"
if old not in s: raise SystemExit('IL2CPP token coverage anchor changed')
s=s.replace(old,new,1)
p.write_text(s)
