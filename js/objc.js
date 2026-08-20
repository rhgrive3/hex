/* Backward-compatible Objective-C metadata facade plus runtime dispatch intelligence. */
import { buildObjcModel as buildLegacyObjcModel } from './objc-legacy.js';
import { parseObjcExtendedMetadata } from './apple/objc-metadata.js';
import { buildObjcRuntimeIndex } from './apple/objc-runtime.js';

export * from './objc-legacy.js';
export { parseObjcExtendedMetadata } from './apple/objc-metadata.js';
export { buildObjcRuntimeIndex, resolveObjcDispatch, formatObjcMessage, objcMessage, recognizeObjcBlockLiteral, classifyObjcRuntimeCall } from './apple/objc-runtime.js';
export { buildSelectorIndex, resolveSelectorStub, selectorFromSymbol } from './apple/selector-stubs.js';

function categorySymbol(category, method, classMethod) {
  if (!method || method.imp == null || !method.selector) return null;
  const owner = category.className || '<unknown>';
  const suffix = category.name ? `(${category.name})` : '';
  return {
    addr: method.imp,
    name: `${classMethod ? '+' : '-'}[${owner}${suffix} ${method.selector}]`,
    source: 'objc-category',
    types: method.types || method.type || method.typeEncoding || null,
  };
}

function categoryNames(categories = []) {
  const out = [];
  const seen = new Set();
  for (const category of categories) {
    for (const method of category.instanceMethods || category.methods || []) {
      const entry = categorySymbol(category, method, false);
      if (!entry) continue;
      const key = `${entry.addr}:${entry.name}`;
      if (!seen.has(key)) { seen.add(key); out.push(entry); }
    }
    for (const method of category.classMethods || []) {
      const entry = categorySymbol(category, method, true);
      if (!entry) continue;
      const key = `${entry.addr}:${entry.name}`;
      if (!seen.has(key)) { seen.add(key); out.push(entry); }
    }
  }
  return out;
}

/** Full Apple-runtime Objective-C model used by the App. */
export async function buildObjcRuntimeModel(read, classList, runtimeSections = {}, onProgress, imageBase, pointerFormat) {
  const base = await buildLegacyObjcModel(read, classList, onProgress, imageBase, pointerFormat);
  const extra = await parseObjcExtendedMetadata(read, runtimeSections, {
    imageBase,
    classes: base.classes || [],
  });
  const names = (base.names || []).slice();
  const seen = new Set(names.map((entry) => `${entry.addr}:${entry.name}`));
  for (const entry of categoryNames(extra.categories)) {
    const key = `${entry.addr}:${entry.name}`;
    if (!seen.has(key)) { seen.add(key); names.push(entry); }
  }
  const model = {
    ...base,
    names,
    protocols: extra.protocols || [],
    categories: extra.categories || [],
    runtimeCompleteness: extra.completeness || null,
    runtime: 'objc',
  };
  model.runtimeIndex = buildObjcRuntimeIndex(model);
  return model;
}
