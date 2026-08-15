from pathlib import Path
import subprocess

p = Path('js/decompiler/pipeline-core.js')
s = p.read_text()
old = "if (d.negate) out = expr.unary('neg', out, v.bits || 64, signedFor(state, v), origin(d, v));"
new = "if (d.extra?.negate) out = expr.unary('neg', out, v.bits || 64, signedFor(state, v), origin(d, v));"
if old in s:
    s = s.replace(old, new, 1)
elif new not in s:
    raise SystemExit('MNEG anchor missing')
a = s.find('function controllingBranchForMemoryPhi')
b = s.find('function memoryNodeExpression', a)
if a < 0 or b < 0:
    raise SystemExit('controllingBranchForMemoryPhi missing')
chunk = s[a:b].replace("if (term?.op !== 'cbr' || (block.succ || []).length < 2) continue;", "if (term?.op !== 'cbr' || block.succ.length < 2) continue;", 1)
s = s[:a] + chunk + s[b:]
p.write_text(s)

p = Path('tools/fix-decompiler-ir-open-1.py')
lines = p.read_text().splitlines()
lines = [line for line in lines if not line.startswith("replace('js/decompiler/pipeline-core.js', 'if (d.negate)")]
p.write_text('\n'.join(lines) + '\n')
subprocess.run(['python', 'tools/fix-decompiler-ir-open-1.py'], check=True)

p = Path('js/decompiler/pipeline-core.js')
s = p.read_text()
a = s.find('function postDominators(ir) {')
b = s.find('function controllingBranchForMemoryPhi', a)
if a >= 0 and b >= 0:
    s = s[:a] + s[b:]
s = s.replace('  const pdom = postDominators(state.ir);\n', '', 1)
s = s.replace('    if (!pdom[yes]?.has(phi.block) || !pdom[no]?.has(phi.block)) continue;\n', '', 1)
old = """function returnValueAt(inst, state) {
  const explicit=valueOf(inst?.args?.[0]);
  if (explicit) return explicit;
  const reg=returnRegisterForState(state);
  if (reg) return reachingRegisterValue(state.ir, inst, reg);
  const candidate=reachingRegisterValue(state.ir, inst, 'x0');
  return candidate?.def && candidate.def.block === inst?.block ? candidate : null;
}"""
new = """function returnValueAt(inst, state) {
  const explicit=valueOf(inst?.args?.[0]);
  if (explicit) return explicit;
  const reg=returnRegisterForState(state);
  return reg ? reachingRegisterValue(state.ir, inst, reg) : null;
}"""
if old in s:
    s = s.replace(old, new, 1)
elif new not in s:
    raise SystemExit('pipeline returnValueAt anchor missing')
p.write_text(s)

# Existing fixtures intentionally exercise value returns. Under #130 they must
# provide trusted ABI/type evidence rather than relying on incidental x0.
p = Path('tests/decompiler-semantic.mjs')
s = p.read_text()
old = "addr: base, name: 'apply_damage', rowOfAddress, receiverType: 'Unit', beginner: false,"
new = "addr: base, name: 'apply_damage', rowOfAddress, returnType: 'int32', receiverType: 'Unit', beginner: false,"
if old in s:
    s = s.replace(old, new, 1)
elif new not in s:
    raise SystemExit('apply_damage fixture anchor missing')
p.write_text(s)

p = Path('tests/issues-350-399.mjs')
s = p.read_text()
old = "decompile(model,{addr:BASE,name:'widthRead',rowOfAddress,beginner:false})"
new = "decompile(model,{addr:BASE,name:'widthRead',rowOfAddress,returnType:'uint32',beginner:false})"
if old in s:
    s = s.replace(old, new, 1)
elif new not in s:
    raise SystemExit('#356 widthRead fixture anchor missing')
p.write_text(s)

p = Path('tests/compiler-truth/run-core.mjs')
s = p.read_text()
old = "decompile(prebuilt, { name:'max_prebuilt', addr:0x200000n, rowOfAddress:(a)=>preMap.get(a?.toString()) ?? null, decompilerTimeBudgetMs:120 })"
new = "decompile(prebuilt, { name:'max_prebuilt', addr:0x200000n, returnType:'int32', rowOfAddress:(a)=>preMap.get(a?.toString()) ?? null, decompilerTimeBudgetMs:120 })"
if old in s:
    s = s.replace(old, new, 1)
elif new not in s:
    raise SystemExit('compiler-truth prebuilt fixture anchor missing')
p.write_text(s)

print('applied current decompiler/IR batch 1')
