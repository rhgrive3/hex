from pathlib import Path


def replace(path, old, new, label):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f'{label} anchor missing in {path}')
    p.write_text(s.replace(old, new, 1))

# #549: symbol names must cross the worker boundary as a structured 1:1 array.
replace('js/symbols.js', """    this.addrs = r.addrs || new BigUint64Array(0);
    this.kinds = r.kinds || new Uint8Array(0);
    this.names = r.names ? r.names.split('\\n') : [];
    /* 1 = 外へ公開されている名前（エクスポート）。0 = このファイルの中だけ。 */
    this.flags = r.flags || new Uint8Array(this.addrs.length);
    this.funcs = r.funcs || new BigUint64Array(0);""", """    const rawAddrs = r.addrs || new BigUint64Array(0);
    const rawKinds = r.kinds || new Uint8Array(rawAddrs.length);
    const rawFlags = r.flags || new Uint8Array(rawAddrs.length);
    const rawNames = Array.isArray(r.names)
      ? r.names.map((name) => String(name ?? ''))
      : (typeof r.names === 'string' && r.names.length ? r.names.split('\\n') : []);
    const symbolCardinalityValid = rawNames.length === rawAddrs.length &&
      rawKinds.length === rawAddrs.length && rawFlags.length === rawAddrs.length;
    this.symbolTransportValid = symbolCardinalityValid;
    this.symbolTransportError = symbolCardinalityValid ? null : 'symbol-cardinality-mismatch';
    /* A mismatched transport can shift every subsequent name to the wrong
       address. Fail closed for symbols while preserving independent function
       starts, so corrupted naming evidence never enters the analysis truth. */
    this.addrs = symbolCardinalityValid ? rawAddrs : new BigUint64Array(0);
    this.kinds = symbolCardinalityValid ? rawKinds : new Uint8Array(0);
    this.names = symbolCardinalityValid ? rawNames : [];
    /* 1 = 外へ公開されている名前（エクスポート）。0 = このファイルの中だけ。 */
    this.flags = symbolCardinalityValid ? rawFlags : new Uint8Array(0);
    this.funcs = r.funcs || new BigUint64Array(0);""", '#549 SymbolIndex structured transport')

replace('js/symbols.js', """    /* True only when LC_FUNCTION_STARTS itself was parsed successfully. ObjC,
       vtables and other metadata may add exact starts without making the list
       complete, so functionCount alone must never suppress stripped recovery. */
    this.functionStartsExact = !!r.functionStartsExact;""", """    /* Exactness and exhaustiveness are independent. `functionStartsExact` is
       retained as the legacy name for an authoritative complete start set;
       `allSeedsExact` only describes the starts currently present. */
    const discoveryComplete = r.discoveryComplete === true || r.functionStartsComplete === true || r.functionStartsExact === true;
    this.allSeedsExact = r.allSeedsExact != null ? !!r.allSeedsExact : !!r.functionStartsExact;
    this.functionStartsComplete = discoveryComplete;
    this.functionStartsExact = discoveryComplete && (r.allSeedsExact == null || this.allSeedsExact);
    this.functionDiscovery = r.functionDiscovery || {
      complete: discoveryComplete,
      capped: !!r.functionStartsCapped,
      reasons: discoveryComplete ? [] : ['function-discovery-incomplete'],
    };""", '#562 SymbolIndex exact-vs-complete')

# Structured producers: platform worker, legacy Mach-O worker, and chained augmentation.
replace('js/platform/worker.js', """  return {
    addrs, kinds, flags, names: sorted.map((x) => x.name).join('\\n'), funcs, functionProvenance, nameProvenance,
    symbolCount: addrs.length, funcCount: funcs.length, capped: false,
    functionStartsExact: functions.length > 0 && (image.functions || []).every(isExactFunctionSeed),
    __transfer: [addrs.buffer, kinds.buffer, flags.buffer, funcs.buffer],
  };""", """  const allSeedsExact = functions.length > 0 && (image.functions || []).every(isExactFunctionSeed);
  /* ELF/PE symbol/unwind/exception seeds can all be exact while still being a
     non-exhaustive subset. The generic platform worker has no exhaustive
     discovery proof, so it must not suppress later heuristic completion. */
  const discoveryComplete = image.metadata?.functionDiscovery?.complete === true;
  return {
    addrs, kinds, flags, names: sorted.map((x) => String(x.name ?? '')), funcs, functionProvenance, nameProvenance,
    symbolCount: addrs.length, funcCount: funcs.length, capped: false,
    allSeedsExact,
    discoveryComplete,
    functionStartsExact: discoveryComplete && allSeedsExact,
    functionDiscovery: { complete: discoveryComplete, capped: false,
      reasons: discoveryComplete ? [] : ['platform-function-seeds-not-exhaustive'] },
    __transfer: [addrs.buffer, kinds.buffer, flags.buffer, funcs.buffer],
  };""", '#549/#562 platform analyze transport')

replace('js/platform/worker.js', """  return { addrs, kinds, flags, names: '', funcs, symbolCount: 0, funcCount: 0, capped: false, functionStartsExact: false, __transfer: [addrs.buffer, kinds.buffer, flags.buffer, funcs.buffer] };""", """  return { addrs, kinds, flags, names: [], funcs, symbolCount: 0, funcCount: 0, capped: false,
    allSeedsExact: false, discoveryComplete: false, functionStartsExact: false,
    functionDiscovery: { complete:false, capped:false, reasons:['platform-function-seeds-not-exhaustive'] },
    __transfer: [addrs.buffer, kinds.buffer, flags.buffer, funcs.buffer] };""", '#549 platform empty names')

replace('js/platform/worker.js', """  const starts = new BigUint64Array(values);
  return { starts, cancelled: false, exact: values.length > 0 && (image?.functions || []).every(isExactFunctionSeed), __transfer: [starts.buffer] };""", """  const starts = new BigUint64Array(values);
  const allSeedsExact = values.length > 0 && (image?.functions || []).every(isExactFunctionSeed);
  return { starts, cancelled: false, exact: allSeedsExact, allSeedsExact,
    complete: false, discoveryComplete: false,
    completeness: { complete:false, capped:false, reasons:['platform-function-discovery-not-exhaustive'] },
    __transfer: [starts.buffer] };""", '#562 platform generic seeds')

replace('js/platform/worker.js', """  return { callFrom, callTo, refFrom, refTo, refKind, kinds, kindsCovered: 0, callsCapped: false, refsCapped: false, words: 0, unsupported: true, __transfer: [callFrom.buffer, callTo.buffer, refFrom.buffer, refTo.buffer, refKind.buffer, kinds.buffer] };""", """  return { callFrom, callTo, refFrom, refTo, refKind, kinds, kindsCovered: 0,
    callsCapped: false, refsCapped: false, words: 0, unsupported: true,
    architecture: image?.arch || null,
    completeness: { complete:false, reasons:['unsupported-program-analysis'] },
    __transfer: [callFrom.buffer, callTo.buffer, refFrom.buffer, refTo.buffer, refKind.buffer, kinds.buffer] };""", '#561 platform unsupported scan')

replace('js/worker-legacy.js', """      addrs: new BigUint64Array(0), kinds: new Uint8Array(0), names: '',
      funcs: new BigUint64Array(0), symbolCount: 0, funcCount: 0, capped: false,
      functionStartsExact: false,""", """      addrs: new BigUint64Array(0), kinds: new Uint8Array(0), names: [],
      funcs: new BigUint64Array(0), symbolCount: 0, funcCount: 0, capped: false,
      allSeedsExact: false, discoveryComplete: false, functionStartsExact: false,
      functionDiscovery: { complete:false, capped:false, reasons:['no-authoritative-function-starts'] },""", '#549 legacy empty names')

replace('js/worker-legacy.js', """    names: names.slice(0, n).join('\\n'),
    funcs,
    symbolCount: n,
    funcCount: funcs.length,
    functionStartsExact,
    capped,""", """    names: names.slice(0, n).map((name) => String(name ?? '')),
    funcs,
    symbolCount: n,
    funcCount: funcs.length,
    allSeedsExact: funcs.length > 0,
    discoveryComplete: functionStartsExact,
    functionStartsExact,
    functionDiscovery: { complete:functionStartsExact, capped:false,
      reasons:functionStartsExact ? [] : ['no-complete-lc-function-starts'] },
    capped,""", '#549/#562 legacy output')

replace('js/chained.js', """  const oldNames = typeof result.names === 'string' ? result.names.split('\\n') : [];""", """  const oldNames = Array.isArray(result.names)
    ? result.names.map((name) => String(name ?? ''))
    : (typeof result.names === 'string' && result.names.length ? result.names.split('\\n') : []);""", '#549 chained input compatibility')
replace('js/chained.js', """  return Object.assign({}, result, { addrs, kinds, flags, names: names.join('\\n') });""", """  return Object.assign({}, result, { addrs, kinds, flags, names });""", '#549 chained structured output')

# #562: only exhaustive discovery may suppress heuristic completion.
replace('js/app.js', """    const sym = this.symbols;
    if (!sym || sym.functionStartsExact) return sym;
    if (!region) return sym;""", """    const sym = this.symbols;
    if (!sym || sym.functionStartsComplete === true || sym.functionDiscovery?.complete === true) return sym;
    if (!region) return sym;""", '#562 app discovery gate')

replace('js/app.js', """        sym.functionDiscovery = res.completeness || { complete: res.complete !== false, capped: !!res.capped };
        sym.functionStartsComplete = res.complete !== false;
        sym.functionStartsCapped = !!res.capped;""", """        sym.functionDiscovery = res.completeness || {
          complete: res.discoveryComplete === true || res.complete === true,
          capped: !!res.capped,
          reasons: res.discoveryComplete === true || res.complete === true ? [] : ['heuristic-function-discovery-incomplete'],
        };
        sym.functionStartsComplete = sym.functionDiscovery.complete === true;
        sym.functionStartsCapped = !!res.capped;""", '#562 app completion result')

# #561: unsupported engine output is an unavailable graph, never a complete empty graph.
replace('js/program.js', """function completeness(array, capped, source, queryLimited = false) {
  const sourceCapped = !!capped;
  const locallyLimited = !!queryLimited;
  Object.defineProperties(array, {
    complete: { value: !sourceCapped && !locallyLimited, enumerable: false, configurable: true },
    capped: { value: sourceCapped, enumerable: false, configurable: true },
    queryLimited: { value: locallyLimited, enumerable: false, configurable: true },
    completenessSource: { value: source, enumerable: false, configurable: true },
    incompleteReason: {
      value: sourceCapped ? `${source}-source-capped` : (locallyLimited ? 'query-limit' : null),
      enumerable: false, configurable: true,
    },
  });
  return array;
}""", """function completeness(array, capped, source, queryLimited = false, unavailableReason = null) {
  const sourceCapped = !!capped;
  const locallyLimited = !!queryLimited;
  const unavailable = unavailableReason || null;
  Object.defineProperties(array, {
    complete: { value: !unavailable && !sourceCapped && !locallyLimited, enumerable: false, configurable: true },
    capped: { value: sourceCapped, enumerable: false, configurable: true },
    queryLimited: { value: locallyLimited, enumerable: false, configurable: true },
    unsupported: { value: unavailable === 'unsupported-program-analysis', enumerable: false, configurable: true },
    completenessSource: { value: source, enumerable: false, configurable: true },
    incompleteReason: {
      value: unavailable || (sourceCapped ? `${source}-source-capped` : (locallyLimited ? 'query-limit' : null)),
      enumerable: false, configurable: true,
    },
  });
  return array;
}""", '#561 completeness helper')

replace('js/program.js', """    this.callsCapped = !!s.callsCapped;
    this.refsCapped = !!s.refsCapped;
    this.words = s.words || 0;
    this.completeness = s.completeness || { complete: !this.callsCapped && !this.refsCapped, reasons: [] };
    this.gen = symbols && symbols.gen != null ? symbols.gen : 0;""", """    this.callsCapped = !!s.callsCapped;
    this.refsCapped = !!s.refsCapped;
    this.words = s.words || 0;
    this.unsupported = !!s.unsupported;
    this.architecture = s.architecture || s.arch || null;
    const suppliedCompleteness = s.completeness && typeof s.completeness === 'object' ? s.completeness : null;
    const reasons = [...new Set([
      ...(Array.isArray(suppliedCompleteness?.reasons) ? suppliedCompleteness.reasons : []),
      ...(this.unsupported ? ['unsupported-program-analysis'] : []),
    ])];
    this.completeness = {
      ...(suppliedCompleteness || {}),
      complete: !this.unsupported && (suppliedCompleteness ? suppliedCompleteness.complete !== false : (!this.callsCapped && !this.refsCapped)),
      reasons,
    };
    this.queryIncompleteReason = this.unsupported ? 'unsupported-program-analysis'
      : (this.completeness.complete === false ? (reasons[0] || 'program-analysis-incomplete') : null);
    this.gen = symbols && symbols.gen != null ? symbols.gen : 0;""", '#561 ProgramIndex state')

replace('js/program.js', """  get statsComplete() { return this.kindsCovered >= this.words; }
  get graphCompleteness() { return Object.freeze({ callsComplete: !this.callsCapped, refsComplete: !this.refsCapped, statsComplete: this.statsComplete }); }""", """  get statsComplete() { return !this.unsupported && this.completeness.complete !== false && this.kindsCovered >= this.words; }
  get graphCompleteness() {
    const sourceComplete = !this.unsupported && this.completeness.complete !== false;
    return Object.freeze({
      supported: !this.unsupported,
      unsupported: this.unsupported,
      architecture: this.architecture,
      reasons: [...(this.completeness.reasons || [])],
      callsComplete: sourceComplete && !this.callsCapped,
      refsComplete: sourceComplete && !this.refsCapped,
      statsComplete: this.statsComplete,
    });
  }""", '#561 graph completeness')

# Every query array carries the base unsupported/incomplete state as well as caps.
for old, new in [
    ("return completeness(out, this.callsCapped, 'calls', queryLimited);", "return completeness(out, this.callsCapped, 'calls', queryLimited, this.queryIncompleteReason);"),
    ("return completeness(Array.from(seen.values()), this.callsCapped, 'calls', queryLimited);", "return completeness(Array.from(seen.values()), this.callsCapped, 'calls', queryLimited, this.queryIncompleteReason);"),
    ("return completeness(Array.from(out.values()), this.callsCapped, 'calls', queryLimited);", "return completeness(Array.from(out.values()), this.callsCapped, 'calls', queryLimited, this.queryIncompleteReason);"),
    ("return completeness(out, this.refsCapped, 'refs', queryLimited);", "return completeness(out, this.refsCapped, 'refs', queryLimited, this.queryIncompleteReason);"),
    ("return completeness(Array.from(seen.values()), this.refsCapped, 'refs', queryLimited);", "return completeness(Array.from(seen.values()), this.refsCapped, 'refs', queryLimited, this.queryIncompleteReason);"),
    ("return completeness(out.slice(0, limit), this.callsCapped, 'calls', out.length > limit);", "return completeness(out.slice(0, limit), this.callsCapped, 'calls', out.length > limit, this.queryIncompleteReason);"),
]:
    p=Path('js/program.js'); s=p.read_text()
    if old not in s:
        raise SystemExit(f'#561 query anchor missing: {old}')
    p.write_text(s.replace(old,new,1))

replace('js/program.js', """  statsOf(start, end) {
    const stats = { total: 0, covered: true, arith: 0, mul: 0, div: 0, logic: 0, shift: 0, farith: 0, fmul: 0, fconv: 0, simd: 0, load: 0, store: 0, cmp: 0, condbr: 0, branch: 0, call: 0, indcall: 0, ret: 0, csel: 0, atomic: 0, movimm: 0, adrp: 0, trap: 0, other: 0 };
    if (!this.kinds.length) { stats.covered = false; return stats; }""", """  statsOf(start, end) {
    const stats = { total: 0, covered: true, arith: 0, mul: 0, div: 0, logic: 0, shift: 0, farith: 0, fmul: 0, fconv: 0, simd: 0, load: 0, store: 0, cmp: 0, condbr: 0, branch: 0, call: 0, indcall: 0, ret: 0, csel: 0, atomic: 0, movimm: 0, adrp: 0, trap: 0, other: 0 };
    if (this.unsupported) { stats.covered = false; stats.unsupported = true; stats.incompleteReason = 'unsupported-program-analysis'; return stats; }
    if (!this.kinds.length) { stats.covered = false; return stats; }""", '#561 stats unsupported')

print('applied issues #549/#561/#562')
