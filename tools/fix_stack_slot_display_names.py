from pathlib import Path

path=Path('js/ir-core.js')
s=path.read_text()
old="""  ordered.forEach((s) => {\n    const disp = s.disp == null ? 0n : s.disp;\n    const d = disp < 0n ? -disp : disp;\n    const sign = disp < 0n ? 'm' : 'p';\n    const base = String(s.baseReg || 'stack').replace(/[^A-Za-z0-9_]/g, '_');\n    s.name = `var_${base}_e${s.frameEpoch}_${sign}${d.toString(16)}`;\n  });\n"""
new="""  // Keep the long-standing compact name when it is unambiguous. Identity is\n  // still the full base+epoch+signed-displacement key; only collisions need the\n  // disambiguating display suffix. This preserves existing UI/API names without\n  // reintroducing the +/- displacement collision fixed by #137.\n  const displayGroups = new Map();\n  for (const s of ordered) {\n    const disp = s.disp == null ? 0n : s.disp;\n    const d = disp < 0n ? -disp : disp;\n    const legacy = `var_${d.toString(16)}`;\n    if (!displayGroups.has(legacy)) displayGroups.set(legacy, []);\n    displayGroups.get(legacy).push(s);\n  }\n  for (const [legacy, group] of displayGroups) {\n    if (group.length === 1) { group[0].name = legacy; continue; }\n    for (const s of group) {\n      const disp = s.disp == null ? 0n : s.disp;\n      const d = disp < 0n ? -disp : disp;\n      const sign = disp < 0n ? 'm' : 'p';\n      const base = String(s.baseReg || 'stack').replace(/[^A-Za-z0-9_]/g, '_');\n      s.name = `var_${base}_e${s.frameEpoch}_${sign}${d.toString(16)}`;\n    }\n  }\n"""
if s.count(old)!=1:
    raise SystemExit(f'stack slot naming anchor changed: {s.count(old)} matches')
path.write_text(s.replace(old,new,1))
print('stack slot display compatibility fix staged')
