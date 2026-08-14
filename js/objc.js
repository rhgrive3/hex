/* Backward-compatible Objective-C metadata facade plus runtime dispatch intelligence. */
import { buildObjcModel as buildLegacyObjcModel } from './objc-legacy.js';
import { parseObjcExtendedMetadata } from './apple/objc-metadata.js';

export * from './objc-legacy.js';
export { parseObjcExtendedMetadata } from './apple/objc-metadata.js';
export { buildObjcRuntimeIndex, resolveObjcDispatch, formatObjcMessage, objcMessage, recognizeObjcBlockLiteral, classifyObjcRuntimeCall } from './apple/objc-runtime.js';
export { buildSelectorIndex, resolveSelectorStub, selectorFromSymbol } from './apple/selector-stubs.js';

/**
 * Full Apple-runtime Objective-C model. Existing callers can keep using the
 * historical buildObjcModel(); consumers that have __objc_protolist and
 * __objc_catlist ranges pass them here and get one dispatch-ready model.
 */
export async function buildObjcRuntimeModel(read, classList, runtimeSections = {}, onProgress, imageBase) {
  const base = await buildLegacyObjcModel(read, classList, onProgress, imageBase);
  const extra = await parseObjcExtendedMetadata(read, runtimeSections, {
    imageBase,
    classes: base.classes || [],
  });
  return {
    ...base,
    protocols: extra.protocols,
    categories: extra.categories,
    runtime: 'objc',
  };
}
