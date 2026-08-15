from pathlib import Path

# Correct #412 fixture: same byte-sized Memory-SSA location, wide SSA source value.
t = Path('tests/issues-lowest-20-20260815.mjs')
s = t.read_text()
old = "'str x8, [sp, #8]'"
if old not in s:
    raise SystemExit('narrow-load fixture anchor missing')
t.write_text(s.replace(old, "'strb w8, [sp, #8]'", 1))

# #416: fold BFI/MOVK constants after the MOVK lifting fix strips its encoded shift.
p = Path('js/ir-core.js')
s = p.read_text()
old = """      case OP.UN: setConst(inst.dst, foldUn(inst.sub, argConst(inst.args[0], bits), bits)); break;"""
new = """      case OP.BFI: {
        const prior = argConst(inst.args[0], bits), src = argConst(inst.args[1], bits);
        if (prior != null && src != null) {
          const lsb = Math.max(0, Math.min(bits - 1, Number(inst.extra?.lsb || 0)));
          const width = Math.max(1, Math.min(bits - lsb, Number(inst.extra?.width || 16)));
          const lowMask = (1n << BigInt(width)) - 1n;
          if (inst.extra?.bitfieldKind === 'bfxil') {
            const field = (mask(src, bits) >> BigInt(lsb)) & lowMask;
            setConst(inst.dst, mask((mask(prior, bits) & ~lowMask) | field, bits));
          } else {
            const fieldMask = lowMask << BigInt(lsb);
            const field = (mask(src, bits) & lowMask) << BigInt(lsb);
            setConst(inst.dst, mask((mask(prior, bits) & ~fieldMask) | field, bits));
          }
        }
        break;
      }
      case OP.UN: setConst(inst.dst, foldUn(inst.sub, argConst(inst.args[0], bits), bits)); break;"""
if old not in s:
    raise SystemExit('BFI propagation anchor missing')
p.write_text(s.replace(old, new, 1))
