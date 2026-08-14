import { enhanceSemanticDecompilation as enhanceCore } from './pipeline-core.js';
import { recoverExactStackPhiExpressions } from './passes/stack-phi-recovery.js';

export { buildExpressionForTesting } from './pipeline-core.js';

/**
 * Public semantic-decompiler pipeline. The core builds typed/re-written ASTs;
 * this final exact-stack pass repairs source variables that Clang -O0 spills
 * through multiple CFG arms when Memory-SSA phi incoming lists are incomplete.
 */
export function enhanceSemanticDecompilation(result, model, opts = {}) {
  return recoverExactStackPhiExpressions(enhanceCore(result, model, opts), opts);
}
