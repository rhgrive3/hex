from pathlib import Path

path = Path('js/decompiler/flag-semantics.js')
text = path.read_text()
old = """  const left = expr.variable(`(${leftText})`, bits, null, source);
  const right = expr.variable(`(${rightText})`, bits, null, source);"""
new = """  const left = expr.variable(String(leftText), bits, null, source);
  const right = expr.variable(String(rightText), bits, null, source);"""
if text.count(old) != 1:
    raise SystemExit(f'flag-semantics: expected one render variable match, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))
