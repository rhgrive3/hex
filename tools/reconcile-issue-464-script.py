from pathlib import Path

p=Path('js/app.js'); text=p.read_text()
text=text.replace("this.symbols = new SymbolIndex({ regions: this.store.get('regions') || [] });","this.symbols = new SymbolIndex({});")
text=text.replace("this.symbols = new SymbolIndex({ ...res, regions: this.store.get('regions') || [] });","this.symbols = new SymbolIndex(res);")
p.write_text(text)

p=Path('js/script.js'); text=p.read_text()
old="    functionAt(addr) { return app.symbols.functionAt(BigInt(addr)); },"
new="""    functionAt(addr) {
      /* Bind containment to the active slice's executable regions before lookup. */
      app.symbols.setFunctionRegions(app.store.get('regions') || [], false);
      return app.symbols.functionAt(BigInt(addr));
    },"""
if new not in text:
    if old not in text: raise SystemExit('script functionAt anchor not found')
    text=text.replace(old,new,1)
p.write_text(text)
