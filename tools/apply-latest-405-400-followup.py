from pathlib import Path

path = Path('js/ir-core.js')
text = path.read_text()
old = """        index: p.addr.index ? topOf(p.addr.index) : null,
        scale: p.addr.scale || 0,
        size: p.addr.size,"""
new = """        index: p.addr.index ? topOf(p.addr.index) : null,
        scale: p.addr.scale || 0,
        extend: p.addr.extend || null,
        size: p.addr.size,"""
if text.count(old) != 1:
    raise SystemExit(f'js/ir-core.js: expected one address emit match, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))
