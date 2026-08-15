/* Objective-C runtime intelligence built on top of objc.js metadata parsing. */

function cleanClassName(name) {
  if (!name) return null;
  return String(name).replace(/^class\s+/, '').replace(/\s*\*+\s*$/, '').replace(/^@?"|"$/g, '').trim() || null;
}

function methodKey(classMethod, selector) { return `${classMethod ? '+' : '-'}:${selector || ''}`; }

function pushIndex(map, key, value) {
  if (!key) return;
  let list = map.get(key);
  if (!list) { list = []; map.set(key, list); }
  list.push(value);
}

function normalizeMethod(m, owner, classMethod, source = 'class') {
  const selector = m && (m.sel || m.selector || m.name && String(m.name).match(/\s([^\]]+)\]$/)?.[1]);
  if (!selector) return null;
  return {
    selector,
    className: owner,
    classMethod: !!classMethod,
    imp: m.addr != null ? m.addr : (m.imp != null ? m.imp : null),
    types: m.types || m.type || null,
    source,
    raw: m,
  };
}

/** Build immutable indices without changing the parser's original model. */
export function buildObjcRuntimeIndex(objcModel = {}) {
  const classes = new Map();
  const methodsBySelector = new Map();
  const protocolRequirementsBySelector = new Map();
  const methodsByIMP = new Map();
  const categories = [];
  const protocols = new Map();

  for (const c of objcModel.classes || []) {
    if (!c || !c.name) continue;
    const info = {
      ...c,
      name: cleanClassName(c.name),
      superName: cleanClassName(c.superName),
      protocols: (c.protocols || []).map((p) => cleanClassName(p.name || p)).filter(Boolean),
    };
    classes.set(info.name, info);
    for (const m of info.methods || []) {
      const x = normalizeMethod(m, info.name, false);
      if (!x) continue;
      pushIndex(methodsBySelector, methodKey(false, x.selector), x);
      if (x.imp != null) pushIndex(methodsByIMP, x.imp.toString(), x);
    }
    for (const m of info.classMethods || []) {
      const x = normalizeMethod(m, info.name, true);
      if (!x) continue;
      pushIndex(methodsBySelector, methodKey(true, x.selector), x);
      if (x.imp != null) pushIndex(methodsByIMP, x.imp.toString(), x);
    }
  }

  for (const p of objcModel.protocols || []) {
    if (!p || !p.name) continue;
    const name = cleanClassName(p.name);
    const copy = { ...p, name };
    protocols.set(name, copy);
    for (const m of p.methods || p.instanceMethods || []) {
      const x = normalizeMethod(m, name, false, 'protocol');
      if (x) pushIndex(protocolRequirementsBySelector, methodKey(false, x.selector), x);
    }
    for (const m of p.classMethods || []) {
      const x = normalizeMethod(m, name, true, 'protocol');
      if (x) pushIndex(protocolRequirementsBySelector, methodKey(true, x.selector), x);
    }
  }

  for (const cat of objcModel.categories || []) {
    if (!cat) continue;
    const targetClass = cleanClassName(cat.className || cat.targetClass || cat.target);
    const name = cat.name || '(category)';
    const entry = { ...cat, name, targetClass };
    categories.push(entry);
    for (const m of cat.methods || cat.instanceMethods || []) {
      const x = normalizeMethod(m, targetClass, false, 'category');
      if (x) { x.category = name; pushIndex(methodsBySelector, methodKey(false, x.selector), x); }
    }
    for (const m of cat.classMethods || []) {
      const x = normalizeMethod(m, targetClass, true, 'category');
      if (x) { x.category = name; pushIndex(methodsBySelector, methodKey(true, x.selector), x); }
    }
  }

  return {
    runtime: 'objc', classes, protocols, categories, methodsBySelector, protocolRequirementsBySelector, methodsByIMP,
    selectorCount: methodsBySelector.size,
    methodCount: [...methodsBySelector.values()].reduce((n, a) => n + a.length, 0),
    protocolRequirementCount: [...protocolRequirementsBySelector.values()].reduce((n, a) => n + a.length, 0),
  };
}

function hierarchy(index, receiverType, budget = 64) {
  const out = [];
  let name = cleanClassName(receiverType);
  const seen = new Set();
  while (name && !seen.has(name) && out.length < budget) {
    seen.add(name);
    out.push(name);
    const c = index.classes.get(name);
    name = c ? cleanClassName(c.superName) : null;
  }
  return out;
}

function protocolSet(index, chain, explicit) {
  const out = new Set((explicit || []).map((p) => cleanClassName(p.name || p)).filter(Boolean));
  for (const name of chain) {
    const c = index.classes.get(name);
    for (const p of (c && c.protocols) || []) out.add(cleanClassName(p));
  }
  return out;
}

function protocolRequirements(index, key, allowedProtocols) {
  const all = index.protocolRequirementsBySelector?.get(key) || [];
  if (!allowedProtocols.size) return all.slice();
  return all.filter((m) => allowedProtocols.has(m.className));
}

/**
 * Resolve an Objective-C message conservatively. If more than one target remains
 * plausible, all candidates are returned and `resolved` stays null. Protocol
 * method entries are requirements, not implementations, and are returned only
 * as separate evidence.
 */
export function resolveObjcDispatch(index, { receiverType = null, selector, classMethod = false, protocols = null } = {}) {
  if (!index || !selector) return { resolved: null, candidates: [], requirements: [], confidence: 0, reason: 'missing runtime index or selector' };
  const key = methodKey(classMethod, selector);
  const cleanReceiver = cleanClassName(receiverType);
  const chain = hierarchy(index, cleanReceiver);
  const ranks = new Map(chain.map((n, i) => [n, i]));
  const allowedProtocols = protocolSet(index, chain, protocols);
  const requirements = protocolRequirements(index, key, allowedProtocols);
  const all = (index.methodsBySelector.get(key) || []).filter((m) => m.source !== 'protocol' && m.imp != null);
  if (!all.length) {
    return {
      resolved: null, candidates: [], requirements, confidence: requirements.length ? 0.35 : 0.1,
      receiverType: cleanReceiver, selector, classMethod: !!classMethod,
      reason: requirements.length ? 'protocol requirement present but implementation IMP is unknown' : 'selector implementation not present in parsed metadata',
    };
  }

  let candidates = all.map((m) => {
    let score = 0.25;
    let reason = m.source;
    if (m.source === 'category' && m.className && ranks.has(m.className)) { score = 0.91; reason = 'category on receiver hierarchy'; }
    else if (ranks.has(m.className)) { score = Math.max(0.6, 0.98 - ranks.get(m.className) * 0.08); reason = ranks.get(m.className) ? 'superclass method' : 'receiver class method'; }
    return { ...m, score, reason };
  });

  if (cleanReceiver) {
    const narrowed = candidates.filter((m) => ranks.has(m.className));
    if (!narrowed.length) {
      return {
        resolved: null,
        candidates: [],
        requirements,
        confidence: 0,
        receiverType: cleanReceiver,
        selector,
        classMethod: !!classMethod,
        reason: 'selector candidates contradict the explicit receiver type',
      };
    }
    candidates = narrowed;
  }
  candidates.sort((a, b) => b.score - a.score || String(a.className).localeCompare(String(b.className)));

  const top = candidates[0];
  const second = candidates[1];
  const unambiguous = !!top && top.imp != null && (!second || top.score - second.score >= 0.16 || (second.imp != null && top.imp.toString() === second.imp.toString()));
  return {
    resolved: unambiguous ? top : null,
    candidates,
    requirements,
    confidence: top ? top.score : 0,
    receiverType: cleanReceiver,
    selector,
    classMethod: !!classMethod,
    reason: unambiguous ? top.reason : 'multiple plausible Objective-C implementations',
  };
}

export function formatObjcMessage({ receiver = 'receiver', selector, args = [], style = 'objc' } = {}) {
  if (!selector) return `unknown_call(${[receiver, ...args].join(', ')})`;
  if (style === 'dot') {
    const stem = selector.replace(/:/g, '_').replace(/_+$/, '');
    return `${receiver}.${stem}(${args.join(', ')})`;
  }
  const parts = String(selector).split(':');
  if (parts.length <= 1 || !selector.includes(':')) return `[${receiver} ${selector}]`;
  let body = '';
  for (let i = 0; i < parts.length - 1; i++) {
    if (i) body += ' ';
    body += `${parts[i]}:${args[i] != null ? args[i] : `a${i + 1}`}`;
  }
  return `[${receiver} ${body}]`;
}

/** Convert objc_msgSend evidence into a semantic representation. */
export function objcMessage(index, { receiver, receiverType, selector, args = [], classMethod = false, protocols = null, style = 'objc' } = {}) {
  const dispatch = resolveObjcDispatch(index, { receiverType, selector, classMethod, protocols });
  return {
    runtime: 'objc', kind: 'message', receiver, receiverType: cleanClassName(receiverType), selector,
    args: args.slice(), dispatch,
    text: formatObjcMessage({ receiver: receiver || 'receiver', selector, args, style }),
    ambiguous: !dispatch.resolved && dispatch.candidates.length > 1,
  };
}

/**
 * Recognize a Block_layout from already-decoded fields. `fields` may be a Map or
 * an object keyed by byte offset. We require an invoke pointer; captures are kept
 * as evidence, never guessed into source variable names.
 */
export function recognizeObjcBlockLiteral(fields, opts = {}) {
  const get = (off) => fields instanceof Map ? fields.get(off) : fields && (fields[off] ?? fields['0x' + off.toString(16)]);
  const isa = get(0), flags = get(8), invoke = get(16), descriptor = get(24);
  if (invoke == null) return null;
  const captures = [];
  const entries = fields instanceof Map ? [...fields.entries()] : Object.entries(fields || {}).map(([k, v]) => [Number(k), v]);
  for (const [rawOff, value] of entries) {
    const off = Number(rawOff);
    if (Number.isFinite(off) && off >= 32) captures.push({ offset: off, value });
  }
  captures.sort((a, b) => a.offset - b.offset);
  return {
    runtime: 'objc', kind: 'block', isa: isa ?? null, flags: flags ?? null,
    invoke, descriptor: descriptor ?? null, captures,
    text: `block(${captures.map((_, i) => `capture${i + 1}`).join(', ')})`,
    confidence: isa != null || descriptor != null ? 0.9 : 0.72,
    evidence: ['Block_layout invoke pointer at +0x10'],
    address: opts.address ?? null,
  };
}

const ARC_NOISE = [
  /^_?objc_(retain|release|autorelease|retainAutoreleasedReturnValue|autoreleaseReturnValue|storeStrong|storeWeak|destroyWeak|initWeak|loadWeakRetained)\b/,
  /^_?_Block_(copy|release)\b/,
];

export function classifyObjcRuntimeCall(name) {
  const n = String(name || '');
  if (ARC_NOISE.some((r) => r.test(n))) return { runtime: 'objc', noise: true, category: 'ownership', name: n };
  if (/objc_msgSend/.test(n)) return { runtime: 'objc', noise: false, category: 'dispatch', name: n };
  if (/objc_(get|set)Property/.test(n)) return { runtime: 'objc', noise: false, category: 'property', name: n };
  return null;
}