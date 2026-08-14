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

export function resolveAppleCall(index, call = {}) {
  const name = call.name || call.symbol || '';
  const origin = call.runtime || runtimeOriginForSymbol(name);
  if (origin === 'objc' || /objc_msgSend/.test(name)) {
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
  return { runtime: origin, kind: call.target != null ? 'direct' : 'indirect', resolved: call.target != null ? { target: call.target, name: name || null } : null, candidates: [] };
}
