from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]

def rep(path, old, new, count=1):
    p=ROOT/path; s=p.read_text()
    if old not in s: raise RuntimeError(f'missing {path}: {old[:120]!r}')
    p.write_text(s.replace(old,new,count))

# #313 — correlated evidence from one family receives diminishing weight.
rep('js/report.js',
"""      hits.push({ type: 'string-ref', row: r.row, addr: r.value, term: hit });""",
"""      hits.push({ type: 'string-ref', sourceGroup: 'strings', row: r.row, addr: r.value, term: hit });""")
rep('js/report.js',
"""      if (hit) hits.push({ type: 'selector', row: c.row, selector: c.selector, term: hit });""",
"""      if (hit) hits.push({ type: 'selector', sourceGroup: 'selectors', row: c.row, selector: c.selector, term: hit });""")
rep('js/report.js',
"""    if (hit) hits.push({ type: 'name-match', term: hit });""",
"""    if (hit) hits.push({ type: 'name-match', sourceGroup: 'symbol-name', term: hit });""")
rep('js/report.js',
"""      if (hit) hits.push({ type: 'caller-name', addr: c.from, term: hit });""",
"""      if (hit) hits.push({ type: 'caller-name', sourceGroup: 'caller-names', addr: c.from, term: hit });""")
rep('js/report.js',
"""  if (hits.length) {
    const conf = Math.min(0.92, 0.35 + 0.18 * hits.length);
    out.push(inference('goal-related', conf, hits.slice(0, 6), 'evidence', { goal: goal.id }));
  }""",
"""  if (hits.length) {
    const byGroup = new Map();
    for (const hit of hits) {
      const key = hit.sourceGroup || hit.type;
      byGroup.set(key, (byGroup.get(key) || 0) + 1);
    }
    // First independent source carries full weight. Repeated observations from
    // the same family are correlated and add only diminishing support.
    let effective = 0;
    for (const n of byGroup.values()) effective += 1 + Math.min(0.5, Math.max(0, n - 1) * 0.15);
    const conf = Math.min(0.92, 0.35 + 0.18 * effective);
    out.push(inference('goal-related', conf, hits.slice(0, 6), 'evidence', {
      goal: goal.id, independentEvidenceGroups: byGroup.size, rawEvidenceCount: hits.length,
    }));
  }""")

# #314 — hard-cap state is explicit and propagated to the SymbolIndex owner.
rep('js/worker.js',
"""  return { starts, cancelled: false, __transfer: [starts.buffer] };
}""",
"""  const capped = found.size >= cap;
  return {
    starts, cancelled: false, capped, truncated: capped, complete: !capped, cap,
    completeness: {
      complete: !capped,
      reason: capped ? 'function-start-cap-reached' : null,
      discovered: list.length,
      cap,
      addressRange: { regionId, vmAddr: region.vmAddr, size: region.size, complete: !capped },
    },
    __transfer: [starts.buffer],
  };
}""", 1)
rep('js/app.js',
"""        sym.addFunctions(res.starts);
        sym.guessed = true;""",
"""        sym.addFunctions(res.starts);
        sym.guessed = true;
        sym.functionDiscovery = res.completeness || { complete: res.complete !== false, capped: !!res.capped };
        sym.functionStartsComplete = res.complete !== false;
        sym.functionStartsCapped = !!res.capped;""")

# #325 — emit resolved BL/BLR target at execution time and preserve typed trace events.
rep('js/emu.js',
"""    if (mn === 'bl' || mn === 'blr') {
      const target = mn === 'bl' ? this.branchTarget(ops) : R(ops[0]);
      this.x[30] = at + 4n;""",
"""    if (mn === 'bl' || mn === 'blr') {
      const target = mn === 'bl' ? this.branchTarget(ops) : R(ops[0]);
      if (target != null && this.trace.length < 4000) {
        this.trace.push({ type:'call', addr:at, address:at, target, indirect:mn === 'blr', text:(mn + ' ' + opsStr).trim() });
      }
      this.x[30] = at + 4n;""")
rep('js/adapters/index.js',
"""function callsFromTrace(trace) {
  return (trace || []).filter((e) => /^(bl|blr)\b/i.test(e.text || '')).map((e) => {
    const match = /^bl\s+#?(0x[0-9a-f]+|[0-9]+)/i.exec(e.text || '');
    let target = null; try { if (match) target = BigInt(match[1]); } catch { target = null; }
    return { type:'call', address:e.addr ?? e.address, target, text:e.text };
  });
}""",
"""function callsFromTrace(trace) {
  const out = [];
  for (const e of trace || []) {
    if (e?.type === 'call') {
      out.push({ type:'call', address:e.addr ?? e.address, target:e.target ?? null, indirect:!!e.indirect, text:e.text });
      continue;
    }
    if (!/^(bl|blr)\b/i.test(e?.text || '')) continue;
    const match = /^bl\s+#?(0x[0-9a-f]+|[0-9]+)/i.exec(e.text || '');
    let target = null; try { if (match) target = BigInt(match[1]); } catch { target = null; }
    out.push({ type:'call', address:e.addr ?? e.address, target, indirect:/^blr\b/i.test(e.text || ''), text:e.text });
  }
  return out;
}""")
rep('js/adapters/index.js',
"""    for (const e of trace) this.traceBuffer.push({ type:'instruction', address:e.addr, text:e.text });
    for (const e of branches) this.traceBuffer.push({ type:'branch', ...e });
    const calls = callsFromTrace(trace), returns = returnsFromTrace(trace);""",
"""    for (const e of trace) {
      if (e?.type === 'call') continue; // emitted below once, with resolved target
      this.traceBuffer.push({ type:'instruction', address:e.addr, text:e.text });
    }
    for (const e of branches) this.traceBuffer.push({ type:'branch', ...e });
    const calls = callsFromTrace(trace), returns = returnsFromTrace(trace);""")
rep('js/adapters/index.js',
"""    for (const call of callsFromTrace([event])) this.traceBuffer.push(call);
    for (const ret of returnsFromTrace([event])) this.traceBuffer.push(ret);
    this.traceCursor = (sandbox.emulator.trace || []).length;""",
"""    const freshTrace = (sandbox.emulator.trace || []).slice(this.traceCursor);
    const directCalls = callsFromTrace(freshTrace.filter((e) => e?.type === 'call'));
    if (directCalls.length) for (const call of directCalls) this.traceBuffer.push(call);
    else for (const call of callsFromTrace([event])) this.traceBuffer.push(call);
    for (const ret of returnsFromTrace([event])) this.traceBuffer.push(ret);
    this.traceCursor = (sandbox.emulator.trace || []).length;""")

# #339 — only actual COFF function type becomes a high-confidence function seed.
rep('js/binary/pe-loader.js',
"""      const functionLike = !!(type & 0x20) || (sec && sec.perms.execute && storage === 2);
      image.symbols.push({ name, address, size: null, kind: functionLike ? 'function' : 'symbol', binding: storage === 2 ? 'global' : 'local', defined: secNo > 0, sectionIndex: secNo, source: 'COFF' });
      if (functionLike && address) image.functions.push(functionSeed(address, { name, source: 'symbol', confidence: 0.98 }));""",
"""      const derivedFunction = !!(type & 0x20);
      const executableExternal = !!(sec && sec.perms.execute && storage === 2);
      image.symbols.push({ name, address, size: null, kind: derivedFunction ? 'function' : 'symbol', binding: storage === 2 ? 'global' : 'local', defined: secNo > 0, sectionIndex: secNo, source: 'COFF' });
      if (derivedFunction && address) image.functions.push(functionSeed(address, { name, source: 'symbol', confidence: 0.98 }));
      else if (executableExternal && address) image.functions.push(functionSeed(address, { name, source: 'symbol-heuristic', confidence: 0.55 }));""")

print('remaining core fixes applied')
