from pathlib import Path

path = Path('js/decompiler/flag-semantics.js')
text = path.read_text()
old = """function directCompare(op, left, right, signed, bits, source) {
  const a = signed ? withSignedWidth(left, bits, source) : withUnsignedWidth(left, bits, source);
  const b = signed ? withSignedWidth(right, bits, source) : withUnsignedWidth(right, bits, source);
  return a && b ? expr.compare(op, a, b, signed, source) : null;
}"""
new = """function directCompare(op, left, right, signed, bits, source) {
  // The AST comparison carries signedness/width semantics. Do not inject
  // redundant textual casts here: recovered fields/locals already have their
  // declared C type, and double-casts make otherwise readable predicates noisy.
  // Architecture-specific cases that cannot be represented by a normal C
  // comparison are retained as explicit NZCV intrinsics below.
  void bits;
  return left && right ? expr.compare(op, left, right, signed, source) : null;
}"""
if text.count(old) != 1:
    raise SystemExit(f'flag-semantics: expected one directCompare match, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))
