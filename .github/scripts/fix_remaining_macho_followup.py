from pathlib import Path

path = Path('js/binary/source-loaders.js')
text = path.read_text()
old = "    selected: { index: all.indexOf(selected), arch: sliceArchName(selected), cpu: selected.cpu, subtype: selected.subtype, offset: selected.offset, size: selected.size },"
new = "    selected: { arch: sliceArchName(selected), cpu: selected.cpu, subtype: selected.subtype, offset: selected.offset, size: selected.size },"
if text.count(old) != 1:
    raise SystemExit(f'expected one selected metadata entry, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))
print('follow-up compatibility patch applied')
