import { createLocalEngine as createBaseLocalEngine } from './local-engine-base.js';

/**
 * The fallback engine remains behavior-compatible, but a first-party QueryAPI
 * context must not prewarm or read direct App analysis indexes. Its deterministic
 * planner consumes the same query-backed capability object as the main AI core.
 */
export function createLocalEngine(app, localContext) {
  if (localContext?.analysisAuthority !== 'AnalysisQueryAPI') {
    return createBaseLocalEngine(app, localContext);
  }

  const facade = Object.create(app);
  Object.defineProperties(facade, {
    ensureStrings:{ value:async () => [], enumerable:false },
    ensureProgram:{ value:async () => null, enumerable:false },
    stringIndex:{ value:[], enumerable:false },
    program:{ value:null, enumerable:false },
  });
  return createBaseLocalEngine(facade, localContext);
}

export default createLocalEngine;
