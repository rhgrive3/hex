from pathlib import Path


def rep(path, old, new, label):
    p=Path(path); s=p.read_text()
    if new in s:
        print('already',label); return
    if old not in s:
        raise SystemExit(f'missing {label} in {path}')
    p.write_text(s.replace(old,new,1))

# #433 cross-binary replay must require an accepted, high-confidence, unambiguous identity.
rep('js/runtime/index.js', """      const resolved = await resolveFunction({ functionAddress, fingerprint:original.functionFingerprint || source.functionFingerprint || null, sourceBinaryHash:sourceHash, targetBinaryHash:targetHash });
      if (resolved == null) return { status:'unsupported', reason:'function-re-resolution-failed', sourceHash, targetHash, evidence:[] };
      functionAddress = asAddress(resolved.address ?? resolved);""", """      const resolved = await resolveFunction({ functionAddress, fingerprint:original.functionFingerprint || source.functionFingerprint || null, sourceBinaryHash:sourceHash, targetBinaryHash:targetHash });
      if (resolved == null) return { status:'unsupported', reason:'function-re-resolution-failed', sourceHash, targetHash, evidence:[] };
      const confidence = Number(resolved && typeof resolved === 'object' ? (resolved.identityConfidence ?? resolved.confidence ?? resolved.score) : NaN);
      const margin = Number(resolved && typeof resolved === 'object' ? (resolved.ambiguityMargin ?? resolved.margin) : NaN);
      const accepted = !!(resolved && typeof resolved === 'object' && resolved.accepted === true);
      const ambiguous = !!(resolved && typeof resolved === 'object' && resolved.ambiguous === true);
      if (!accepted || !Number.isFinite(confidence) || confidence < 0.85 || ambiguous || (Number.isFinite(margin) && margin < 0.10)) {
        return { status:'unsupported', reason:'function-re-resolution-ambiguous', sourceHash, targetHash, confidence:Number.isFinite(confidence)?confidence:null, ambiguityMargin:Number.isFinite(margin)?margin:null, evidence:[] };
      }
      functionAddress = asAddress(resolved.address);""", '#433 replay identity')

# #434 expose fact-trace completion rather than silently dropping tail events.
rep('js/runtime-evidence/index.js', """  const facts = [];
  for (const event of events) {
    if (facts.length >= limit) break;
    const common = { runtime:true, sessionId:context.sessionId || null, binaryHash:context.binaryHash || null, provenance:{ group:GROUP.RUNTIME, observationGroup:group, independent:false }, address:event.address ?? null, confidence:safeConfidence(context.confidence,0.8) };""", """  const facts = [];
  let processedEvents = 0;
  let limitTruncated = false;
  for (const event of events) {
    if (facts.length >= limit) { limitTruncated = true; break; }
    processedEvents++;
    const common = { runtime:true, sessionId:context.sessionId || null, binaryHash:context.binaryHash || null, provenance:{ group:GROUP.RUNTIME, observationGroup:group, independent:false }, address:event.address ?? null, confidence:safeConfidence(context.confidence,0.8) };""", '#434 fact count')
rep('js/runtime-evidence/index.js', """  }
  return facts;
}

export function compareRuntimeDispatch""", """  }
  const sourceIncomplete = !!(trace && !Array.isArray(trace) && (trace.complete === false || trace.truncated === true));
  facts.processedEvents = processedEvents;
  facts.totalEvents = events.length;
  facts.truncated = limitTruncated || sourceIncomplete;
  facts.complete = !facts.truncated && processedEvents === events.length;
  facts.reason = limitTruncated ? 'fact-limit' : sourceIncomplete ? (trace.reason || 'source-truncated') : null;
  for (const fact of facts) fact.traceComplete = facts.complete;
  return facts;
}

export function compareRuntimeDispatch""", '#434 completion metadata')

# #435 bounded call graph searches must report why they stopped.
rep('js/query/causal.js', """  const q = [[from]];
  const out = [];
  let visited = 0;
  while (q.length && out.length < maxPaths && visited++ < maxVisited) {""", """  const q = [[from]];
  const out = [];
  const reasons = new Set();
  let visited = 0;
  while (q.length && out.length < maxPaths && visited < maxVisited) {
    visited++;""", '#435 loop')
rep('js/query/causal.js', """    if (path.length >= maxDepth) continue;
    let range = null;""", """    if (path.length >= maxDepth) { reasons.add('depth-cap'); continue; }
    let range = null;""", '#435 depth')
rep('js/query/causal.js', """    try { callees = program.calleesOf(head, range && range.end, 200) || []; } catch { callees = []; }
    for (const c of callees) {""", """    try { callees = program.calleesOf(head, range && range.end, 200) || []; } catch { callees = []; }
    if (callees.length >= 200) reasons.add('callee-cap');
    for (const c of callees) {""", '#435 callee cap')
rep('js/query/causal.js', """  }
  return out.sort((a, b) => a.length - b.length);
}""", """  }
  if (q.length && visited >= maxVisited) reasons.add('visited-cap');
  if (out.length >= maxPaths && q.length) reasons.add('path-cap');
  out.sort((a, b) => a.length - b.length);
  out.visited = visited;
  out.reasons = Array.from(reasons);
  out.truncated = out.reasons.length > 0;
  out.complete = !out.truncated && q.length === 0;
  return out;
}""", '#435 result')

# #436 forward memory slices must traverse Memory-SSA phi nodes.
rep('js/slice.js', """/* ── 前向き ─────────────────────────────────────────────────── */

/**""", """/* ── 前向き ─────────────────────────────────────────────────── */

function memoryNodeContainsStore(node, store, seen = new Set()) {
  if (!node || !store || seen.has(node)) return false;
  seen.add(node);
  if (node.kind === 'store') return node.inst === store;
  if (node.kind === 'phi') return (node.incoming || []).some((inc) => memoryNodeContainsStore(inc && inc.node, store, seen));
  return false;
}

/**""", '#436 helper')
rep('js/slice.js', """      for (const r of readersByLoc.get(inst.loc.key) || []) {
        if (r.reachingStore === inst) stack.push(r);
      }""", """      for (const r of readersByLoc.get(inst.loc.key) || []) {
        if (r.reachingStore === inst || memoryNodeContainsStore(r.memUse, inst)) stack.push(r);
      }""", '#436 forward')

# #437 inferred terminal x0 is evidence, not sufficient proof for wrapper propagation.
rep('js/interproc.js', """  const oneReturn = returns.length === 1 ? returns[0] : null;

  const getter = !!(oneReturn && oneReturn.kind === 'field' && nonStackWrites.length === 0);""", """  const oneReturn = returns.length === 1 ? returns[0] : null;
  const trustedReturn = oneReturn && oneReturn.inferred !== true ? oneReturn : null;

  const getter = !!(trustedReturn && trustedReturn.kind === 'field' && nonStackWrites.length === 0);""", '#437 trusted return')
rep('js/interproc.js', """    (oneReturn && (oneReturn.kind === 'call' || oneReturn.kind === 'argument' || oneReturn.kind === 'constant'));
  const forwarding = calls.length === 1 && nonStackWrites.length === 0 && rmw.length === 0 &&
    branches.length === 0 && unknownPointerStores.length === 0 && !!oneReturn;""", """    (trustedReturn && (trustedReturn.kind === 'call' || trustedReturn.kind === 'argument' || trustedReturn.kind === 'constant'));
  const forwarding = calls.length === 1 && nonStackWrites.length === 0 && rmw.length === 0 &&
    branches.length === 0 && unknownPointerStores.length === 0 && !!trustedReturn;""", '#437 classifications')
rep('js/interproc.js', """      simpleArithmeticWrapper: !!(oneReturn && oneReturn.kind === 'argument-arithmetic'),
    },""", """      simpleArithmeticWrapper: !!(trustedReturn && trustedReturn.kind === 'argument-arithmetic'),
      returnEvidence: oneReturn ? (oneReturn.inferred === true ? 'inferred' : 'explicit') : 'none',
    },""", '#437 metadata')

# #438 arithmetic summaries preserve width/signedness and wrap using machine width.
rep('js/interproc.js', """    return { kind: 'argument-arithmetic', argument: Number(a.reg.slice(1)), op: v.def.sub, constant: b.const };""", """    return { kind: 'argument-arithmetic', argument: Number(a.reg.slice(1)), op: v.def.sub, constant: b.const, bits:Number(v.bits || 64), signed:v.signed ?? null };""", '#438 lhs')
rep('js/interproc.js', """    return { kind: 'argument-arithmetic', argument: Number(b.reg.slice(1)), op: 'add', constant: a.const };""", """    return { kind: 'argument-arithmetic', argument: Number(b.reg.slice(1)), op: 'add', constant: a.const, bits:Number(v.bits || 64), signed:v.signed ?? null };""", '#438 rhs')
rep('js/interproc.js', """      return { kind: 'constant', value: r.op === 'sub' ? actual.value - r.constant : actual.value + r.constant, via: 'callee-summary' };""", """      const bits = Math.max(1, Math.min(64, Number(r.bits || 64)));
      const raw = r.op === 'sub' ? actual.value - r.constant : actual.value + r.constant;
      const value = BigInt.asUintN(bits, raw);
      return { kind: 'constant', value, bits, signed:r.signed ?? null, via: 'callee-summary' };""", '#438 wrap')

# #439 a PHI only has one computation path if operation/provenance is identical, not merely the root load.
rep('js/dataflow-semantic.js', """function sameLoadLocation(a, b) {
  return !!(a && b && a.loc && b.loc && a.loc.key && a.loc.key === b.loc.key);
}""", """function sameLoadLocation(a, b) {
  return !!(a && b && a.loc && b.loc && a.loc.key && a.loc.key === b.loc.key);
}
function sameStep(a, b) {
  if (!a || !b || a.op !== b.op || a.imm !== b.imm || a.immFloat !== b.immFloat || a.other !== b.other) return false;
  const ao=a.otherOrigin, bo=b.otherOrigin;
  if (!!ao !== !!bo) return false;
  if (!ao) return true;
  return ao.kind===bo.kind && ao.reg===bo.reg && ao.value===bo.value && ao.address===bo.address && ao.disp===bo.disp && ao.base===bo.base;
}
function sameComputationPath(a,b) {
  return !!(a && b && sameLoadLocation(a.load,b.load) && a.steps.length===b.steps.length && a.steps.every((s,i)=>sameStep(s,b.steps[i])));
}""", '#439 compare')
rep('js/dataflow-semantic.js', """    if (paths.length === def.args.length && paths.length && paths.every((p) => sameLoadLocation(paths[0].load, p.load))) {
      out = paths[0];
    }""", """    if (paths.length === def.args.length && paths.length && paths.every((p) => sameComputationPath(paths[0], p))) {
      out = paths[0];
    }""", '#439 phi')

# #440 setters accept only Objective-C argument x2/w2, not x3-x7 aliases.
rep('js/verify.js', """    const next = insn.reads.find((r) => /^[wx][2-7]$/.test(r)) || insn.reads[0];
    if (!next) return false;
    if (/^[wx][2-7]$/.test(next)) return true;""", """    const next = insn.reads.find((r) => /^(?:x2|w2)$/.test(r)) || insn.reads[0];
    if (!next) return false;
    if (/^(?:x2|w2)$/.test(next)) return true;""", '#440 arg2')

# #441 protocol declarations are candidates/evidence, never concrete resolved implementations by themselves.
rep('js/apple/objc-runtime.js', """  const top = candidates[0];
  const second = candidates[1];
  const unambiguous = !!top && (!second || top.score - second.score >= 0.16 || (top.imp != null && second.imp != null && top.imp.toString() === second.imp.toString()));
  return {
    resolved: unambiguous ? top : null,""", """  const top = candidates[0];
  const second = candidates[1];
  const concreteTop = !!(top && top.source !== 'protocol' && top.imp != null);
  const unambiguous = concreteTop && (!second || top.score - second.score >= 0.16 || (second.source !== 'protocol' && second.imp != null && top.imp.toString() === second.imp.toString()));
  return {
    resolved: unambiguous ? top : null,""", '#441 concrete dispatch')
rep('js/apple/objc-runtime.js', """    reason: unambiguous ? top.reason : 'multiple plausible Objective-C targets',""", """    reason: unambiguous ? top.reason : (!concreteTop && top && top.source === 'protocol' ? 'protocol declaration has no concrete implementation target' : 'multiple plausible Objective-C targets'),""", '#441 reason')
