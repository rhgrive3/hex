from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def rw(path, old, new, count=1):
    p = ROOT / path
    s = p.read_text()
    if old not in s:
        raise RuntimeError(f'pattern missing in {path}: {old[:100]!r}')
    p.write_text(s.replace(old, new, count))

# #307: preserve FP immediates and keep FP arithmetic distinct from integer arithmetic.
rw('js/expr.js',
   "export function constNode(v) { return node('const', { v: BigInt(v) }); }\nexport function regNode(reg, row) { return node('reg', { reg, row: row == null ? -1 : row }); }",
   "export function constNode(v) { return node('const', { v: BigInt(v) }); }\nexport function floatNode(v, bits = 64) {\n  const value = Number(v);\n  return Number.isFinite(value) ? node('float', { v: value, bits: Number(bits || 64) }) : null;\n}\nexport function regNode(reg, row) { return node('reg', { reg, row: row == null ? -1 : row }); }")
rw('js/expr.js', "    case 'const': return a.v === b.v;", "    case 'const': return a.v === b.v;\n    case 'float': return Object.is(a.v, b.v) && a.bits === b.bits;")
rw('js/expr.js',
   "  fadd: 'add', fsub: 'sub', fmul: 'mul', fdiv: 'sdiv',",
   "  fadd: 'fadd', fsub: 'fsub', fmul: 'fmul', fdiv: 'fdiv',")
rw('js/expr.js',
   "      if (op.value == null) return op.float != null ? constNode(0n) : null;",
   "      if (op.value == null) return op.float != null ? floatNode(op.float, bits) : null;")
rw('js/expr.js',
   "    } else if (base === 'neg' || base === 'negs' || base === 'fneg') {\n      emit(dst, un('neg', A()));",
   "    } else if (base === 'neg' || base === 'negs') {\n      emit(dst, un('neg', A()));\n    } else if (base === 'fneg') {\n      emit(dst, node('un', { op: 'fneg', a: A() }));")
rw('js/expr.js',
   "    } else if (base === 'madd' || base === 'fmadd') {\n      emit(dst, bin('add', valueOf(insn.ops[3], row, bits), bin('mul', A(), B(), bits), bits));\n    } else if (base === 'msub' || base === 'fmsub') {\n      emit(dst, bin('sub', valueOf(insn.ops[3], row, bits), bin('mul', A(), B(), bits), bits));",
   "    } else if (base === 'madd') {\n      emit(dst, bin('add', valueOf(insn.ops[3], row, bits), bin('mul', A(), B(), bits), bits));\n    } else if (base === 'fmadd') {\n      emit(dst, bin('fadd', valueOf(insn.ops[3], row, bits), bin('fmul', A(), B(), bits), bits));\n    } else if (base === 'msub') {\n      emit(dst, bin('sub', valueOf(insn.ops[3], row, bits), bin('mul', A(), B(), bits), bits));\n    } else if (base === 'fmsub') {\n      emit(dst, bin('fsub', valueOf(insn.ops[3], row, bits), bin('fmul', A(), B(), bits), bits));")
rw('js/expr.js',
   "  add: 9, sub: 9, mul: 10, sdiv: 10, udiv: 10, smod: 10, umod: 10,",
   "  add: 9, sub: 9, fadd: 9, fsub: 9, mul: 10, fmul: 10, fdiv: 10, sdiv: 10, udiv: 10, smod: 10, umod: 10,")
rw('js/expr.js',
   "  add: '+', sub: '-', mul: '*', sdiv: '/', udiv: '/', smod: '%', umod: '%',",
   "  add: '+', sub: '-', fadd: '+', fsub: '-', mul: '*', fmul: '*', fdiv: '/', sdiv: '/', udiv: '/', smod: '%', umod: '%',")
rw('js/expr.js', "    case 'const': return hexOf(n.v);", "    case 'const': return hexOf(n.v);\n    case 'float': return Number.isInteger(n.v) ? n.v.toFixed(1) : String(n.v);")
rw('js/expr.js', "    case 'neg': return '-' + inner;", "    case 'neg': return '-' + inner;\n    case 'fneg': return '-' + inner;")

# #308 and #306: W-register reads are explicit truncations and W writes zero-extend into X state.
rw('js/expr.js',
   "function narrow32(v) {\n  if (!v) return v;\n  if (v.k === 'const') return constNode(wrap(v.v, 32));\n  if (v.k === 'un' && (v.op === 'sxt32' || v.op === 'uxt32')) return v.a;\n  return v;\n}",
   "function narrow32(v) {\n  if (!v) return v;\n  if (v.k === 'const') return constNode(v.v & 0xffffffffn);\n  if (v.k === 'un' && v.op === 'uxt32') return v;\n  return un('uxt32', v);\n}")
rw('js/expr.js',
   "    const emit = (key, v) => {\n      if (!key || key === 'zr' || !v) return;\n      set(key, v, row);",
   "    const emit = (key, v) => {\n      if (!key || key === 'zr' || !v) return;\n      // A write to Wn architecturally clears Xn[63:32]. Keep that fact in the\n      // value graph instead of letting stale upper bits survive.\n      const writtenOp = insn.ops && insn.ops[0];\n      if (writtenOp && writtenOp.k === 'reg' && writtenOp.cls === 'gp' && writtenOp.bits === 32 && key === regKeyOf(writtenOp)) {\n        v = un('uxt32', v);\n      }\n      set(key, v, row);")

# #303/#304: conditional compare is not an unconditional compare; stale NZCV cannot cross unknown writers/calls.
rw('js/expr.js',
   "    if (insn.isCall) {\n      const call = callRows.get(row);",
   "    if (insn.isCall) {\n      flags = null; // NZCV is caller-clobbered and cannot be reused after a call.\n      const call = callRows.get(row);")
rw('js/expr.js',
   "    if (/^(subs|adds|ands|bics|negs)$/.test(base)) {\n      flags = { op: base, a: A(), b: B() };\n    }",
   "    const knownFlagWriter = /^(subs|adds|ands|bics|negs|cmp|cmn|tst|fcmp|fcmpe|ccmp|ccmn)$/.test(base);\n    const unsupportedFlagWriter = /^(adcs|sbcs|ngcs|rmif|setf8|setf16)$/.test(base);\n    if (unsupportedFlagWriter) flags = null;\n    if (/^(subs|adds|ands|bics|negs)$/.test(base)) {\n      flags = { op: base, a: A(), b: B() };\n    }\n    // Unknown instructions explicitly reported as writing NZCV must invalidate\n    // the remembered predicate even when their mnemonic is not in our table.\n    if (!knownFlagWriter && (insn.writes || []).includes('nzcv')) flags = null;")
rw('js/expr.js',
   "    } else if (base === 'cmp' || base === 'cmn' || base === 'tst' || base === 'fcmp' ||\n               base === 'fcmpe' || base === 'ccmp' || base === 'ccmn') {",
   "    } else if (base === 'ccmp' || base === 'ccmn') {\n      // CCMP/CCMN writes compare flags only when its condition is true and an\n      // encoded NZCV literal otherwise. Treating it as CMP invents a predicate.\n      // Until the flag state is represented as a conditional value, forget it.\n      flags = null;\n    } else if (base === 'cmp' || base === 'cmn' || base === 'tst' || base === 'fcmp' ||\n               base === 'fcmpe') {")

# #305: CINC is the alias "cond ? x+1 : x"; CSINC remains "cond ? a : b+1".
rw('js/expr.js',
   "  let alt = b;\n  if (base === 'csinc' || base === 'cinc') alt = bin('add', b, constNode(1n), bits);",
   "  if (base === 'cinc') {\n    const inc = bin('add', a, constNode(1n), bits);\n    return node('sel', { cc: cond, cmp, a: inc, b: a });\n  }\n  let alt = b;\n  if (base === 'csinc') alt = bin('add', b, constNode(1n), bits);")

# #311: register shifts use the low log2(width) bits of the shift count.
rw('js/expr.js',
   "    } else if (BIN_MN[base]) {\n      emit(dst, bin(BIN_MN[base], A(), B(), bits));",
   "    } else if (BIN_MN[base]) {\n      const variableShift = /^(lslv|lsrv|asrv|rorv)$/.test(base);\n      const rhs = variableShift ? bin('and', B(), constNode(BigInt(bits - 1)), bits) : B();\n      emit(dst, bin(BIN_MN[base], A(), rhs, bits));")

# #309/#310: preserve indexed-address extension/shift and memory result semantics.
rw('js/expr.js',
   "              index: m.index ? regs.get(m.index) || regNode(m.index, row) : null,\n              size: pair ? m.size / 2 : m.size,\n              signed: /^(ldrs|ldurs|ldpsw)/.test(base),",
   "              index: m.index ? applyShift(regs.get(m.index) || regNode(m.index, row), memOp && memOp.shift, 64) : null,\n              indexShift: memOp && memOp.shift ? { ...memOp.shift } : null,\n              scale: m.scale ?? null,\n              size: pair ? m.size / 2 : m.size,\n              resultBits: regBits(dop),\n              extension: /^(ldrs|ldurs|ldpsw)/.test(base) ? 'sign' : (regBits(dop) === 32 ? 'zero' : null),\n              signed: /^(ldrs|ldurs|ldpsw)/.test(base),")
rw('js/expr.js',
   "      return a.baseReg === b.baseReg && a.disp === b.disp && a.size === b.size &&\n        (!!a.base === !!b.base) && (!a.base || same(a.base, b.base)) &&\n        (!!a.index === !!b.index) && (!a.index || same(a.index, b.index));",
   "      return a.baseReg === b.baseReg && a.disp === b.disp && a.size === b.size &&\n        a.signed === b.signed && a.resultBits === b.resultBits && a.extension === b.extension &&\n        a.scale === b.scale && JSON.stringify(a.indexShift || null) === JSON.stringify(b.indexShift || null) &&\n        (!!a.base === !!b.base) && (!a.base || same(a.base, b.base)) &&\n        (!!a.index === !!b.index) && (!a.index || same(a.index, b.index));")

# #317: distinguish access displacement from base writeback displacement.
rw('js/arm64.js',
   "  const mem = { k: 'mem', text, base, index: null, disp: null, shift: null, mode: bang ? 'pre' : 'offset' };",
   "  const mem = { k: 'mem', text, base, index: null, disp: null, addressDisp: null, writebackDisp: null, shift: null, mode: bang ? 'pre' : 'offset' };")
rw('js/arm64.js',
   "    if (imm) { mem.disp = imm; continue; }",
   "    if (imm) { mem.disp = imm; mem.addressDisp = imm; continue; }")
rw('js/arm64.js',
   "  return mem;\n}\n\n/**\n * Capstone の operand",
   "  if (mem.mode === 'pre' && mem.disp) mem.writebackDisp = mem.disp;\n  return mem;\n}\n\n/**\n * Capstone の operand")
rw('js/arm64.js',
   "      out[i].disp = out[i + 1];\n      out[i].mode = 'post';",
   "      out[i].writebackDisp = out[i + 1];\n      out[i].addressDisp = null;\n      out[i].disp = null;\n      out[i].mode = 'post';")
rw('js/blocks.js',
   "      disp: mem.disp && mem.disp.value != null ? mem.disp.value : null,\n      indexed: !!mem.index,",
   "      disp: mem.addressDisp && mem.addressDisp.value != null ? mem.addressDisp.value : (mem.disp && mem.disp.value != null ? mem.disp.value : null),\n      writebackDisp: mem.writebackDisp && mem.writebackDisp.value != null ? mem.writebackDisp.value : null,\n      indexed: !!mem.index,")
rw('js/expr.js',
   "        if (memOp && (memOp.mode === 'pre' || memOp.mode === 'post') && m.base && m.disp != null) {\n          emit(m.base, bin('add', get(m.base, row), constNode(m.disp), 64));\n        }",
   "        if (memOp && (memOp.mode === 'pre' || memOp.mode === 'post') && m.base && m.writebackDisp != null) {\n          emit(m.base, bin('add', get(m.base, row), constNode(m.writebackDisp), 64));\n        }", 1)
rw('js/expr.js',
   "        if (memOp && (memOp.mode === 'pre' || memOp.mode === 'post') && m.base && m.disp != null) {\n          emit(m.base, bin('add', get(m.base, row), constNode(m.disp), 64));\n        }",
   "        if (memOp && (memOp.mode === 'pre' || memOp.mode === 'post') && m.base && m.writebackDisp != null) {\n          emit(m.base, bin('add', get(m.base, row), constNode(m.writebackDisp), 64));\n        }", 1)

print('expr/ARM64 semantic fixes applied')
