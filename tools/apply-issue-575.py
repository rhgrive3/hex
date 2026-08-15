from pathlib import Path
p = Path('js/decompiler/pipeline-core.js')
text = p.read_text()
old = "      if (d.negate) out = expr.unary('neg', out, v.bits || 64, signedFor(state, v), origin(d, v));\n"
new = "      if (d.extra?.negate) out = expr.unary('neg', out, v.bits || 64, signedFor(state, v), origin(d, v));\n"
if new not in text:
    if old not in text: raise SystemExit('MNEG negate anchor not found')
    text = text.replace(old, new, 1)
p.write_text(text)
