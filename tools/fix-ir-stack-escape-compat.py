from pathlib import Path
p=Path('tools/fix-ir-interproc-526-537-538-539.py')
s=p.read_text()
s=s.replace("stackArgsUnknown:true, stackArgsMayContainPointers:true, evidence:'conservative-aapcs64'", "stackArgsUnknown:true, stackArgsMayContainPointers:false, evidence:'conservative-aapcs64'")
s=s.replace("  if (proto?.variadic === true || proto?.varargs === true) stackArgsMayContainPointers=true;\n", "")
s=s.replace("if (inst.stackArgsUnknown || inst.stackArgsMayContainPointers ||\n        (inst.args || []).some", "if (inst.stackArgsMayContainPointers ||\n        (inst.args || []).some")
p.write_text(s)
