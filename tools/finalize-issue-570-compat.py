from pathlib import Path
p=Path('js/binary/macho-dyld.js')
s=p.read_text()
old="const imp = { name, library, ordinal: libOrdinal, weak, addend, source: 'chained-fixups', sites: [] };"
new="const imp = { name, library, ordinal: libOrdinal, weak, addend, source: 'chained-fixups', sites: [], chainedIndex:i };"
if old not in s: raise SystemExit('budgeted chained import provenance anchor missing')
p.write_text(s.replace(old,new,1))
