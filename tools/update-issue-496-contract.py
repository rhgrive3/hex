from pathlib import Path

p=Path('tests/run.js')
text=p.read_text()
old="""  dv.setBigUint64(0, 3n, true);
  dv.setBigUint64(8, 0x2100n, true);
  for (let i = 0; i < 3; i++) dv.setBigUint64(0x100 + i * 8, 0x1000n + BigInt(i * 4), true);
"""
new="""  dv.setBigUint64(0, 3n, true);
  dv.setBigUint64(8, 0x2100n, true);
  // Verified legacy CodeRegistration requires neighboring count/pointer pairs,
  // not just one executable-looking table.
  dv.setBigUint64(16, 1n, true);
  dv.setBigUint64(24, 0x2180n, true);
  dv.setBigUint64(32, 1n, true);
  dv.setBigUint64(40, 0x2190n, true);
  for (let i = 0; i < 3; i++) dv.setBigUint64(0x100 + i * 8, 0x1000n + BigInt(i * 4), true);
"""
if new not in text:
    if old not in text: raise SystemExit('legacy IL2CPP test anchor not found')
    text=text.replace(old,new,1)
p.write_text(text)
