import { buildObjcRuntimeIndex, classifyObjcRuntimeCall, objcMessage } from './objc-runtime.js';
import { buildSelectorIndex, resolveSelectorStub } from './selector-stubs.js';
import { buildSwiftRuntimeIndex, classifySwiftRuntimeCall, resolveSwiftDispatch, swiftCallingConvention, formatSwiftCall } from '../swift.js';

export function runtimeOriginForSymbol(name) {
  const n = String(name || '');
  if (/^_?\$[sS]/.test(n) || /^_?swift_/.test(n)) return 'swift';
  if (/^[+-]\[/.test(n) || /^_?objc_/.test(n) || /objc_msgSend/.test(n)) return 'objc';
  if (/^__?Z|^_Z/.test(n)) return 'cpp';
  return n ? 'c' : 'unknown';
}

export function buildAppleRuntimeIndex({ objc = null, swift = null, selectorRefs = [], selectorStubs = [], fixups = [] } = {}) {
  return {
    objc: objc && objc.runtime === 'objc' && objc.methodsBySelector ? objc : buildObjcRuntimeIndex(objc || {}),
    swift: swift && swift.runtime === 'swift' && swift.typesByName ? swift : buildSwiftRuntimeIndex(swift || {}),
    selectors: buildSelectorIndex({ selectorRefs, stubs: selectorStubs, fixups }),
    runtime: 'mixed',
  };
}

export function classifyRuntimeCall(name) {
  return classifyObjcRuntimeCall(name) || classifySwiftRuntimeCall(name) || { runtime: runtimeOriginForSymbol(name), noise: false, category: 'call', name: String(name || '') };
}

/** Suppress only well-known compiler/runtime bookkeeping, retaining expert evidence. */
export function shouldFoldRuntimeCall(name, opts = {}) {
  if (opts.expert === true) return false;
  const c = classifyRuntimeCall(name);
  return !!c.noise;
}

/** Resolve an Objective-C IMP/function pointer without pretending duplicate IMPs are unique. */
export function resolveObjcIMP(objcIndex, address, { receiverType = null, selector = null } = {}) {
  if (!objcIndex || address == null) return { resolved: null, candidates: [], confidence: 0 };
  let candidates = (objcIndex.methodsByIMP?.get(BigInt(address).toString()) || []).slice();
  if (selector) candidates = candidates.filter((m) => m.selector === selector);
  if (receiverType) {
    const type = String(receiverType).replace(/\s*\*+\s*$/, '');
    const chain = new Set();
    let cur = type, guard = 0;
    while (cur && guard++ < 64 && !chain.has(cur)) {
      chain.add(cur);
      cur = objcIndex.classes?.get(cur)?.superName || null;
    }
    candidates = candidates.filter((m) => chain.has(m.className));
  }
  const unique = candidates.length === 1 ? candidates[0] : null;
  return {
    resolved: unique,
    candidates,
    confidence: unique ? 0.98 : candidates.length ? 0.55 : 0,
    reason: unique ? 'unique IMP in Objective-C metadata' : candidates.length ? 'IMP is shared by multiple methods' : 'IMP not found in parsed metadata',
  };
}

export function resolveAppleCall(index, call = {}) {
  const name = call.name || call.symbol || '';
  let origin = call.runtime || runtimeOriginForSymbol(name);
  const indirectTarget = call.impTarget ?? call.functionPointer ?? ((call.kind === 'imp' || call.kind === 'function-pointer') ? call.target : null);
  const imp = indirectTarget != null ? resolveObjcIMP(index?.objc, indirectTarget, { receiverType: call.receiverType, selector: call.selector }) : null;
  if (origin === 'unknown' && imp?.candidates?.length) origin = 'objc';

  if (origin === 'objc' || /objc_msgSend/.test(name) || imp?.candidates?.length) {
    if (imp?.candidates?.length && !/objc_msgSend/.test(name)) {
      return {
        runtime: 'objc', kind: 'imp', imp,
        resolved: imp.resolved,
        candidates: imp.candidates,
        text: imp.resolved ? `${imp.resolved.classMethod ? '+' : '-'}[${imp.resolved.className} ${imp.resolved.selector}]` : null,
      };
    }
    let selector = call.selector || null;
    let selectorResolution = null;
    if (!selector && call.stubAddress != null && index?.selectors) {
      selectorResolution = resolveSelectorStub({ address: call.stubAddress, symbol: name, selectorIndex: index.selectors, selectorFor: call.selectorFor });
      selector = selectorResolution.selector;
    }
    const message = selector ? objcMessage(index?.objc, {
      receiver: call.receiver || 'receiver', receiverType: call.receiverType || null,
      selector, args: call.args || [], classMethod: !!call.classMethod,
      protocols: call.protocols || null, style: call.style || 'objc',
    }) : null;
    return { runtime: 'objc', kind: 'message', message, selectorResolution, resolved: message?.dispatch?.resolved || null, candidates: message?.dispatch?.candidates || selectorResolution?.candidates || [] };
  }
  if (origin === 'swift') {
    const dispatch = resolveSwiftDispatch(index?.swift, call);
    const cc = swiftCallingConvention({ name, mangled: call.mangled || name, metadata: call.metadata, attributes: call.callingConvention });
    return { runtime: 'swift', kind: dispatch.kind, dispatch, callingConvention: cc, text: formatSwiftCall(name, call.args || [], cc), resolved: dispatch.resolved, candidates: dispatch.candidates };
  }
  return { runtime: origin, kind: call.target != null ? (call.kind || 'direct') : 'indirect', resolved: call.target != null ? { target: call.target, name: name || null } : null, candidates: [] };
}
