from pathlib import Path

p = Path("js/semantics/compat/semantic-ir-v2-to-v1-nodes.js")
s = p.read_text()
old = """      inst.addr = projectLegacyAddress(addressValueId, node.memory, context);
      if (inst.addr.base && inst.addr.base !== addressValue) addUse(inst.addr.base, inst);"""
new = """      inst.addr = projectLegacyAddress(addressValueId, node.memory, context);
      const exactAddressDisplacement = safeBigInt(opMeta.addressing?.addressDisplacement);
      if (inst.addr.precise && inst.addr.index == null && exactAddressDisplacement != null) {
        inst.addr.disp = exactAddressDisplacement;
        inst.addr.compatDisplacementEvidence = 'machine-effects-addressing-metadata';
      }
      if (inst.addr.base && inst.addr.base !== addressValue) addUse(inst.addr.base, inst);"""
count = s.count(old)
if count != 2:
    raise SystemExit(f"address displacement projection source shape mismatch: {count}")
p.write_text(s.replace(old, new))
