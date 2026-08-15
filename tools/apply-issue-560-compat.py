from pathlib import Path
p=Path('js/app.js')
s=p.read_text()
old="if(this.symbols===EMPTY_INDEX){this.symbols=new SymbolIndex({regions:this.store.get('regions')||[]});this.viewer.setSymbols(this.symbols);}"
new="if(this.symbols===EMPTY_INDEX){this.symbols = new SymbolIndex({ regions: this.store.get('regions') || [] });this.viewer.setSymbols(this.symbols);}"
if old not in s: raise SystemExit('EMPTY_INDEX trust-boundary anchor missing')
p.write_text(s.replace(old,new,1))
