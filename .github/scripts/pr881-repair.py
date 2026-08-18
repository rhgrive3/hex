from pathlib import Path

emu = Path('js/emu.js')
text = emu.read_text()
duplicate = 'await this.ensure(d+i);await this.ensure(d+i);'
if duplicate in text:
    text = text.replace(duplicate, 'await this.ensure(d+i);', 1)
assert "this.setFlags('subs', 0n, operand, result, wide);" in text, 'issue-802 NEGS fix missing'
assert "BigInt.asIntN(op.bits === 32 ? 32 : 64, v) >> s" in text, 'issue-824 ASR fix missing'
emu.write_text(text)

ir = Path('js/ir.js').read_text()
assert "if (a.size == null || b.size == null) return false;" in ir, 'issue-859 mustAlias fix missing'
assert ir.count("if (x.size == null || y.size == null) return true;") >= 2, 'issue-859 mayAlias fix missing'

lowering = Path('js/semantics/ir/normalize-effects.js').read_text()
assert "'srem', 'urem'" in lowering, 'issue-866 remainder classification fix missing'

expr_path = Path('js/expr.js')
expr = expr_path.read_text()
helper_marker = "function signExtendExtractedField(n, width, bits) {"
if helper_marker not in expr:
    marker = "const BIN_MN = {"
    assert expr.count(marker) == 1, 'expr helper insertion marker mismatch'
    helper = '''function signExtendExtractedField(n, width, bits) {
  const fieldBits = Number(width);
  const destinationBits = Number(bits);
  if (!Number.isSafeInteger(fieldBits) || !Number.isSafeInteger(destinationBits) ||
      fieldBits < 1 || fieldBits > destinationBits) return null;
  const c = constOf(n);
  if (c != null) return constNode(BigInt.asIntN(fieldBits, BigInt.asUintN(fieldBits, c)));
  if (fieldBits === destinationBits) return n;
  // After masking to fieldBits, the top field bit is exactly 0 or 1. Subtracting
  // that bit times 2^fieldBits is mathematical sign extension without inventing
  // a target-specific unary node or relying on host signed-shift width.
  const sign = bin('shr', n, constNode(BigInt(fieldBits - 1)), destinationBits);
  const correction = bin('mul', sign, constNode(1n << BigInt(fieldBits)), destinationBits);
  return bin('sub', n, correction, destinationBits);
}

'''
    expr = expr.replace(marker, helper + marker, 1)

old = '''    } else if (base === 'ubfx' || base === 'sbfx') {
      const lsb = insn.ops[2] && insn.ops[2].value != null ? insn.ops[2].value : 0n;
      const width = insn.ops[3] && insn.ops[3].value != null ? insn.ops[3].value : 0n;
      const shifted = bin('shr', A(), constNode(lsb), bits);
      emit(dst, width > 0n && width < 64n ? bin('and', shifted, constNode((1n << width) - 1n), bits) : shifted);
'''
new = '''    } else if (base === 'ubfx' || base === 'sbfx') {
      const lsb = insn.ops[2] && insn.ops[2].value != null ? insn.ops[2].value : 0n;
      const width = insn.ops[3] && insn.ops[3].value != null ? insn.ops[3].value : 0n;
      const destinationWidth = BigInt(bits);
      if (lsb < 0n || width <= 0n || lsb >= destinationWidth || width > destinationWidth - lsb) {
        if (dst) regs.delete(dst);
      } else {
        const shifted = bin('shr', A(), constNode(lsb), bits);
        const extracted = width === destinationWidth
          ? shifted
          : bin('and', shifted, constNode((1n << width) - 1n), bits);
        emit(dst, base === 'sbfx' ? signExtendExtractedField(extracted, width, bits) : extracted);
      }
'''
if old in expr:
    expr = expr.replace(old, new, 1)
else:
    assert "base === 'sbfx' ? signExtendExtractedField" in expr, 'issue-821 guarded replacement mismatch'
expr_path.write_text(expr)
