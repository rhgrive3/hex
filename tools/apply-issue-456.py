from pathlib import Path

p=Path('js/program.js')
text=p.read_text()
old="""function completeness(array, capped, source) {
  Object.defineProperties(array, {
    complete: { value: !capped, enumerable: false, configurable: true },
    capped: { value: !!capped, enumerable: false, configurable: true },
    completenessSource: { value: source, enumerable: false, configurable: true },
  });
  return array;
}
"""
new="""function completeness(array, capped, source, queryLimited = false) {
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
}
"""
if new not in text:
    if old not in text: raise SystemExit('completeness helper anchor not found')
    text=text.replace(old,new,1)

old="""  callSitesTo(target, limit = 500) {
    const order = this._callToOrder(), out = [];
    let i = lowerBound(this.callTo, order, target);
    for (; i < order.length && out.length < limit; i++) {
      const k = order[i]; if (this.callTo[k] !== target) break;
      out.push({ site: this.callFrom[k], caller: this.functionStartOf(this.callFrom[k]) });
    }
    return completeness(out, this.callsCapped, 'calls');
  }
  callersOf(target, limit = 200) {
    const seen = new Map();
    for (const c of this.callSitesTo(target, limit * 4)) {
      const key = c.caller != null ? c.caller.toString() : 's' + c.site.toString();
      if (!seen.has(key)) { seen.set(key, { addr: c.caller, site: c.site, count: 0 }); if (seen.size >= limit) { seen.get(key).count++; break; } }
      seen.get(key).count++;
    }
    return completeness(Array.from(seen.values()), this.callsCapped, 'calls');
  }
  calleesOf(start, end, limit = 200) {
    const out = new Map(); let i = lowerBoundDirect(this.callFrom, start);
    for (; i < this.callFrom.length; i++) {
      const from = this.callFrom[i]; if (end != null && from >= end) break;
      const to = this.callTo[i], key = to.toString();
      if (!out.has(key)) { if (out.size >= limit) break; out.set(key, { addr: to, site: from, count: 0 }); }
      out.get(key).count++;
    }
    return completeness(Array.from(out.values()), this.callsCapped, 'calls');
  }
"""
new="""  callSitesTo(target, limit = 500) {
    const order = this._callToOrder(), out = [];
    let i = lowerBound(this.callTo, order, target), queryLimited = false;
    for (; i < order.length; i++) {
      const k = order[i];
      if (this.callTo[k] !== target) break;
      if (out.length >= limit) { queryLimited = true; break; }
      out.push({ site: this.callFrom[k], caller: this.functionStartOf(this.callFrom[k]) });
    }
    return completeness(out, this.callsCapped, 'calls', queryLimited);
  }
  callersOf(target, limit = 200) {
    const seen = new Map();
    const sites = this.callSitesTo(target, Math.max(0, limit * 4));
    let queryLimited = sites.complete !== true;
    for (const c of sites) {
      const key = c.caller != null ? c.caller.toString() : 's' + c.site.toString();
      if (!seen.has(key)) {
        if (seen.size >= limit) { queryLimited = true; break; }
        seen.set(key, { addr: c.caller, site: c.site, count: 0 });
      }
      seen.get(key).count++;
    }
    return completeness(Array.from(seen.values()), this.callsCapped, 'calls', queryLimited);
  }
  calleesOf(start, end, limit = 200) {
    const out = new Map(); let i = lowerBoundDirect(this.callFrom, start), queryLimited = false;
    for (; i < this.callFrom.length; i++) {
      const from = this.callFrom[i]; if (end != null && from >= end) break;
      const to = this.callTo[i], key = to.toString();
      if (!out.has(key)) {
        if (out.size >= limit) { queryLimited = true; break; }
        out.set(key, { addr: to, site: from, count: 0 });
      }
      out.get(key).count++;
    }
    return completeness(Array.from(out.values()), this.callsCapped, 'calls', queryLimited);
  }
"""
if new not in text:
    if old not in text: raise SystemExit('call query anchors not found')
    text=text.replace(old,new,1)

old="""  refSitesTo(addr, span = 1n, limit = 500) {
    const order = this._refToOrder(), out = []; let i = lowerBound(this.refTo, order, addr);
    const hi = addr + (span > 0n ? span : 1n);
    for (; i < order.length && out.length < limit; i++) {
      const k = order[i]; if (this.refTo[k] >= hi) break;
      out.push({ site: this.refFrom[k], target: this.refTo[k], kind: this.refKind[k] });
    }
    return completeness(out, this.refsCapped, 'refs');
  }
  functionsReferencing(addr, span = 1n, limit = 200) {
    const seen = new Map();
    for (const r of this.refSitesTo(addr, span, limit * 4)) {
      const fn = this.functionStartOf(r.site), key = fn != null ? fn.toString() : 's' + r.site.toString();
      if (!seen.has(key)) { if (seen.size >= limit) break; seen.set(key, { addr: fn, site: r.site, kind: r.kind, count: 0 }); }
      seen.get(key).count++;
    }
    return completeness(Array.from(seen.values()), this.refsCapped, 'refs');
  }
  refsFrom(start, end, limit = 400) {
    const out = []; let i = lowerBoundDirect(this.refFrom, start);
    for (; i < this.refFrom.length && out.length < limit; i++) {
      const from = this.refFrom[i]; if (end != null && from >= end) break;
      out.push({ site: from, target: this.refTo[i], kind: this.refKind[i] });
    }
    return completeness(out, this.refsCapped, 'refs');
  }
"""
new="""  refSitesTo(addr, span = 1n, limit = 500) {
    const order = this._refToOrder(), out = []; let i = lowerBound(this.refTo, order, addr), queryLimited = false;
    const hi = addr + (span > 0n ? span : 1n);
    for (; i < order.length; i++) {
      const k = order[i]; if (this.refTo[k] >= hi) break;
      if (out.length >= limit) { queryLimited = true; break; }
      out.push({ site: this.refFrom[k], target: this.refTo[k], kind: this.refKind[k] });
    }
    return completeness(out, this.refsCapped, 'refs', queryLimited);
  }
  functionsReferencing(addr, span = 1n, limit = 200) {
    const seen = new Map();
    const refs = this.refSitesTo(addr, span, Math.max(0, limit * 4));
    let queryLimited = refs.complete !== true;
    for (const r of refs) {
      const fn = this.functionStartOf(r.site), key = fn != null ? fn.toString() : 's' + r.site.toString();
      if (!seen.has(key)) {
        if (seen.size >= limit) { queryLimited = true; break; }
        seen.set(key, { addr: fn, site: r.site, kind: r.kind, count: 0 });
      }
      seen.get(key).count++;
    }
    return completeness(Array.from(seen.values()), this.refsCapped, 'refs', queryLimited);
  }
  refsFrom(start, end, limit = 400) {
    const out = []; let i = lowerBoundDirect(this.refFrom, start), queryLimited = false;
    for (; i < this.refFrom.length; i++) {
      const from = this.refFrom[i]; if (end != null && from >= end) break;
      if (out.length >= limit) { queryLimited = true; break; }
      out.push({ site: from, target: this.refTo[i], kind: this.refKind[i] });
    }
    return completeness(out, this.refsCapped, 'refs', queryLimited);
  }
"""
if new not in text:
    if old not in text: raise SystemExit('ref query anchors not found')
    text=text.replace(old,new,1)

old="""  mostCalled(limit = 20) {
    const counts = new Map();
    for (let i = 0; i < this.callTo.length; i++) { const key = this.callTo[i].toString(); counts.set(key, (counts.get(key) || 0) + 1); }
    const out = []; for (const [key, n] of counts) out.push({ addr: BigInt(key), count: n });
    out.sort((a, b) => b.count - a.count);
    return completeness(out.slice(0, limit), this.callsCapped, 'calls');
  }
"""
new="""  mostCalled(limit = 20) {
    const counts = new Map();
    for (let i = 0; i < this.callTo.length; i++) { const key = this.callTo[i].toString(); counts.set(key, (counts.get(key) || 0) + 1); }
    const out = []; for (const [key, n] of counts) out.push({ addr: BigInt(key), count: n });
    out.sort((a, b) => b.count - a.count);
    return completeness(out.slice(0, limit), this.callsCapped, 'calls', out.length > limit);
  }
"""
if new not in text:
    if old not in text: raise SystemExit('mostCalled anchor not found')
    text=text.replace(old,new,1)
p.write_text(text)

p=Path('js/report-legacy.js')
text=p.read_text()
old="""  let callers = [];
  let callees = [];
  if (program && startAddr != null) {
    const range = program.functionRange(startAddr) || { start: startAddr, end: endAddr };
    callers = program.callersOf(range.start, 60).map((c) => ({
      addr: c.addr, site: c.site, count: c.count,
      name: c.addr != null && symbols ? symbols.nameAt(c.addr) : null,
    }));
    callees = program.calleesOf(range.start, range.end, 60).map((c) => ({
      addr: c.addr, site: c.site, count: c.count,
      name: symbols ? symbols.nameAt(c.addr) : null,
    }));
    if (callers.length) facts.push(fact('callers', { n: callers.length }));
    if (!callers.length && program.statsComplete === true) facts.push(fact('no-callers', null));
"""
new="""  let callers = [];
  let callees = [];
  let callersComplete = false;
  if (program && startAddr != null) {
    const range = program.functionRange(startAddr) || { start: startAddr, end: endAddr };
    const callerQuery = program.callersOf(range.start, 60);
    const graphCallsComplete = program.graphCompleteness?.callsComplete;
    callersComplete = callerQuery?.complete === true
      || (callerQuery?.complete == null && graphCallsComplete === true);
    if (graphCallsComplete === false) callersComplete = false;
    callers = Array.from(callerQuery || []).map((c) => ({
      addr: c.addr, site: c.site, count: c.count,
      name: c.addr != null && symbols ? symbols.nameAt(c.addr) : null,
    }));
    callees = program.calleesOf(range.start, range.end, 60).map((c) => ({
      addr: c.addr, site: c.site, count: c.count,
      name: symbols ? symbols.nameAt(c.addr) : null,
    }));
    if (callers.length) facts.push(fact('callers', { n: callers.length }));
    if (!callers.length && callersComplete) facts.push(fact('no-callers', null));
"""
if new not in text:
    if old not in text: raise SystemExit('report caller query anchor not found')
    text=text.replace(old,new,1)

old="""  if (program && !program.statsComplete) {
    unknowns.push(unknown('stats-partial', null));
    unknowns.push(unknown('callers-partial', { reason: 'program-index-incomplete', observed: callers.length }));
  }
"""
new="""  if (program && !program.statsComplete) unknowns.push(unknown('stats-partial', null));
  if (program && !callersComplete) {
    unknowns.push(unknown('callers-partial', {
      reason: program.graphCompleteness?.callsComplete === false ? 'call-index-incomplete' : 'caller-query-incomplete',
      observed: callers.length,
    }));
  }
"""
if new not in text:
    if old not in text: raise SystemExit('report unknown completeness anchor not found')
    text=text.replace(old,new,1)

old="""  if (callers.length) nextSteps.push({ code: 'check-callers', detail: { n: callers.length } });
  else if (program && program.statsComplete !== true) nextSteps.push({ code: 'check-callers-incomplete', detail: { reason: 'program-index-incomplete' } });
  else nextSteps.push({ code: 'no-callers-hint', detail: null });
"""
new="""  if (callers.length) nextSteps.push({ code: 'check-callers', detail: { n: callers.length } });
  else if (program && !callersComplete) nextSteps.push({ code: 'check-callers-incomplete', detail: { reason: 'caller-query-incomplete' } });
  else nextSteps.push({ code: 'no-callers-hint', detail: null });
"""
if new not in text:
    if old not in text: raise SystemExit('report nextSteps completeness anchor not found')
    text=text.replace(old,new,1)
p.write_text(text)
