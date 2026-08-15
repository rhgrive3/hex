from pathlib import Path

p=Path('js/app.js')
text=p.read_text()
old="""    if (this.symbols === EMPTY_INDEX) {
      this.symbols = new SymbolIndex({});
      this.viewer.setSymbols(this.symbols);
    }
"""
new="""    if (this.symbols === EMPTY_INDEX) {
      this.symbols = new SymbolIndex({ regions: this.store.get('regions') || [] });
      this.viewer.setSymbols(this.symbols);
    }
"""
if new not in text:
    if old not in text: raise SystemExit('EMPTY_INDEX replacement anchor not found')
    text=text.replace(old,new,1)
old="""      this.symbolsReady = this.backend.analyze(sliceIndex).then((res) => {
        if (epoch !== this.backend.gen || this.store.get('sliceIndex') !== sliceIndex) return;
        this.symbols = new SymbolIndex(res);
"""
new="""      this.symbolsReady = this.backend.analyze(sliceIndex).then((res) => {
        if (epoch !== this.backend.gen || this.store.get('sliceIndex') !== sliceIndex) return;
        // Backend symbol results are slice-global starts, but containment needs
        // the active slice's executable region boundaries. Bind them at the
        // replacement point so every consumer (ProgramIndex, panels, Script)
        // shares the same trust boundary.
        this.symbols = new SymbolIndex({ ...res, regions });
"""
if new not in text:
    if old not in text: raise SystemExit('worker SymbolIndex replacement anchor not found')
    text=text.replace(old,new,1)
p.write_text(text)

p=Path('tests/symbol-identity.mjs')
text=p.read_text()
if "from '../js/program.js'" not in text:
    text=text.replace("import { SymbolIndex } from '../js/symbols.js';\n", "import { SymbolIndex } from '../js/symbols.js';\nimport { ProgramIndex } from '../js/program.js';\nimport { readFile } from 'node:fs/promises';\n",1)
marker="\nconsole.log('symbol identity regression: PASS');\n"
block=r'''

// #464 re-audit: ProgramIndex must observe the same executable-region trust
// boundary as Script lookups. A short global next-start gap in another region
// must not turn trailing padding in region A into function A ownership.
{
  const regionA={ id:'text-a', vmAddr:0x1000n, size:0x200n, exec:true };
  const regionB={ id:'text-b', vmAddr:0x2000n, size:0x200n, exec:true };
  const symbols=new SymbolIndex({
    funcs:new BigUint64Array([0x1100n,0x2000n]),
    regions:[regionA,regionB],
  });
  const program=new ProgramIndex({
    vmAddr:regionA.vmAddr, words:Number(regionA.size/4n), kindsCovered:0,
    kinds:new Uint8Array(0), callFrom:new BigUint64Array(0), callTo:new BigUint64Array(0),
  },symbols,regionA);
  assert.equal(program.functionStartOf(0x1100n),0x1100n,'exact start remains owned');
  assert.equal(program.functionStartOf(0x1180n),null,'region-A trailing padding is not owned across a short region gap');
  assert.equal(symbols.functionAt(0x2000n)?.start,0x2000n,'region-B exact start remains identifiable');
}

// Keep the production App wiring under regression too; the previous fix only
// called setFunctionRegions() in Script.functionAt(), leaving normal worker
// replacement unbound.
{
  const appSource=await readFile(new URL('../js/app.js',import.meta.url),'utf8');
  assert.match(appSource,/new SymbolIndex\(\{ \.\.\.res, regions \}\)/,
    'worker analysis SymbolIndex must receive active slice regions');
  assert.match(appSource,/new SymbolIndex\(\{ regions: this\.store\.get\('regions'\) \|\| \[\] \}\)/,
    'EMPTY_INDEX replacement must retain active region trust boundaries');
}
'''
if block.strip() not in text:
    if marker not in text: raise SystemExit('symbol regression marker not found')
    text=text.replace(marker,block+marker,1)
p.write_text(text)
