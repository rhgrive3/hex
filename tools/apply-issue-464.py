from pathlib import Path

symbols = Path('js/symbols.js')
text = symbols.read_text()

old = """    this.funcs = r.funcs || new BigUint64Array(0);\n    this.capped = !!r.capped;\n"""
new = """    this.funcs = r.funcs || new BigUint64Array(0);\n    /* Optional exact function ends. A zero/missing entry means unknown. */\n    this.funcEnds = r.funcEnds || null;\n    /* Executable regions are the trust boundary for containment. */\n    this.functionRegions = [];\n    this.setFunctionRegions(r.regions || [], false);\n    this.capped = !!r.capped;\n"""
if new not in text:
    if old not in text:
        raise SystemExit('constructor anchor not found')
    text = text.replace(old, new, 1)

old = """  /** そのアドレスが関数の先頭かどうか。 */\n  isFunctionStart(addr) {\n    const i = this._floor(this.funcs, addr);\n    return i >= 0 && this.funcs[i] === addr;\n  }\n\n  /** そのアドレスを含む関数の {start, end}。分からなければ null。 */\n  functionAt(addr) {\n    const i = this._floor(this.funcs, addr);\n    if (i < 0) return null;\n    const start = this.funcs[i];\n    const end = i + 1 < this.funcs.length ? this.funcs[i + 1] : null;\n    return { start, end, index: i };\n  }\n"""
new = """  /** そのアドレスが関数の先頭かどうか。 */\n  isFunctionStart(addr) {\n    const i = this._floor(this.funcs, addr);\n    return i >= 0 && this.funcs[i] === addr;\n  }\n\n  /** Function containment must never cross executable-region gaps. */\n  setFunctionRegions(regions, bump = true) {\n    const out = [];\n    for (const region of regions || []) {\n      if (!region || !region.exec || region.vmAddr == null || region.size == null) continue;\n      try {\n        const start = BigInt(region.vmAddr);\n        const size = BigInt(region.size);\n        if (size <= 0n) continue;\n        out.push({ start, end: start + size, id: region.id ?? null });\n      } catch { /* malformed/untrusted region metadata: ignore */ }\n    }\n    out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));\n    this.functionRegions = out;\n    if (bump) this.gen = ++SymbolIndex.gen;\n    return out.length;\n  }\n\n  _functionRegion(addr) {\n    const rs = this.functionRegions;\n    let lo = 0, hi = rs.length - 1, best = -1;\n    while (lo <= hi) {\n      const mid = (lo + hi) >> 1;\n      if (rs[mid].start <= addr) { best = mid; lo = mid + 1; }\n      else hi = mid - 1;\n    }\n    if (best < 0) return null;\n    const r = rs[best];\n    return addr < r.end ? r : null;\n  }\n\n  _functionEnd(index) {\n    if (index < 0 || index >= this.funcs.length) return null;\n    const start = this.funcs[index];\n    const region = this._functionRegion(start);\n    if (this.funcEnds && index < this.funcEnds.length) {\n      const explicit = this.funcEnds[index];\n      if (explicit != null && explicit > start) {\n        if (region && explicit > region.end) return null;\n        return explicit;\n      }\n    }\n    if (index + 1 >= this.funcs.length) return null;\n    const next = this.funcs[index + 1];\n    if (next <= start || next - start > 0x40000n) return null;\n    if (this.functionRegions.length) {\n      const nextRegion = this._functionRegion(next);\n      if (!region || !nextRegion || nextRegion !== region) return null;\n    }\n    return next;\n  }\n\n  /** そのアドレスを含む関数の {start, end}。分からなければ null。 */\n  functionAt(addr) {\n    const i = this._floor(this.funcs, addr);\n    if (i < 0) return null;\n    const start = this.funcs[i];\n    const end = this._functionEnd(i);\n    if (addr === start) return { start, end, index: i };\n    if (end == null || addr >= end) return null;\n    if (this.functionRegions.length) {\n      const startRegion = this._functionRegion(start);\n      const addrRegion = this._functionRegion(addr);\n      if (!startRegion || !addrRegion || startRegion !== addrRegion) return null;\n    }\n    return { start, end, index: i };\n  }\n"""
if new not in text:
    if old not in text:
        raise SystemExit('functionAt anchor not found')
    text = text.replace(old, new, 1)

old = """      const next = i + 1 < this.funcs.length ? this.funcs[i + 1] : hi;\n      const e = this.exact(a);\n      out.push({\n        addr: a,\n        name: e ? e.name : null,\n        size: next != null && next > a ? next - a : null,\n      });\n"""
new = """      const trustedEnd = this._functionEnd(i);\n      const end = trustedEnd != null && (hi == null || trustedEnd <= hi) ? trustedEnd : null;\n      const e = this.exact(a);\n      out.push({\n        addr: a,\n        name: e ? e.name : null,\n        size: end != null && end > a ? end - a : null,\n      });\n"""
if new not in text:
    if old not in text:
        raise SystemExit('functionList anchor not found')
    text = text.replace(old, new, 1)

old = """    this.funcs = out;\n    this.gen = ++SymbolIndex.gen;\n    return added;\n"""
new = """    this.funcs = out;\n    this.funcEnds = null;\n    this.gen = ++SymbolIndex.gen;\n    return added;\n"""
if new not in text:
    if old not in text:
        raise SystemExit('addFunctions anchor not found')
    text = text.replace(old, new, 1)

old = """  setGuessedFunctions(starts) {\n    this.funcs = starts || new BigUint64Array(0);\n    this.guessed = true;\n"""
new = """  setGuessedFunctions(starts) {\n    this.funcs = starts || new BigUint64Array(0);\n    this.funcEnds = null;\n    this.guessed = true;\n"""
if new not in text:
    if old not in text:
        raise SystemExit('setGuessedFunctions anchor not found')
    text = text.replace(old, new, 1)

symbols.write_text(text)

app = Path('js/app.js')
text = app.read_text()
text2 = text.replace(
    "this.symbols = new SymbolIndex({});",
    "this.symbols = new SymbolIndex({ regions: this.store.get('regions') || [] });",
)
text2 = text2.replace(
    "this.symbols = new SymbolIndex(res);",
    "this.symbols = new SymbolIndex({ ...res, regions: this.store.get('regions') || [] });",
)
if text2 == text and "new SymbolIndex({ ...res, regions:" not in text:
    raise SystemExit('app SymbolIndex anchors not found')
app.write_text(text2)

test = Path('tests/symbol-identity.mjs')
text = test.read_text()
marker = "\nconsole.log('symbol identity regression: PASS');\n"
block = r'''

{
  const index = new SymbolIndex({
    funcs: new BigUint64Array([0x1000n, 0x1100n, 0x3000n, 0x90000n]),
    regions: [
      { id:'text-a', vmAddr:0x1000n, size:0x1000n, exec:true },
      { id:'text-b', vmAddr:0x3000n, size:0x100000n, exec:true },
      { id:'data', vmAddr:0x2000n, size:0x1000n, exec:false },
    ],
  });
  assert.deepEqual(index.functionAt(0x1080n), { start:0x1000n, end:0x1100n, index:0 });
  assert.deepEqual(index.functionAt(0x1100n), { start:0x1100n, end:null, index:1 });
  assert.equal(index.functionAt(0x1180n), null);
  assert.equal(index.functionAt(0x2800n), null);
  assert.equal(index.functionAt(0x5000n), null);
}

{
  const index = new SymbolIndex({
    funcs: new BigUint64Array([0x1000n]),
    funcEnds: new BigUint64Array([0x1080n]),
    regions: [{ id:'text', vmAddr:0x1000n, size:0x1000n, exec:true }],
  });
  assert.deepEqual(index.functionAt(0x107cn), { start:0x1000n, end:0x1080n, index:0 });
  assert.equal(index.functionAt(0x1080n), null);
}
'''
if block.strip() not in text:
    if marker not in text:
        raise SystemExit('test marker not found')
    text = text.replace(marker, block + marker, 1)
test.write_text(text)
