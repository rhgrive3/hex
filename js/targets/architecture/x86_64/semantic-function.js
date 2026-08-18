import {
  analyzeDecodedSemanticFunction as analyzeSharedSemanticFunction,
  partitionDecodedFunction,
  semanticAbiAdapter,
} from '../../../analysis/semantic-function.js';
import { X86_SEMANTIC_FUNCTION_ANALYSIS_VERSION } from './semantic-function-contract.js';

/**
 * x86-64 entry point for the shared semantic-function route.
 *
 * Phase 5 introduced this module as the only caller of the shared pipeline.
 * Phase 6 moved the driver itself to js/analysis/semantic-function.js so that
 * RISC-V64 travels the identical code, and this file remains the stable x86
 * seam: it supplies the x86 defaults (architecture id and analysis version) and
 * nothing else.
 */
export { X86_SEMANTIC_FUNCTION_ANALYSIS_VERSION as SEMANTIC_FUNCTION_ANALYSIS_VERSION };
export { partitionDecodedFunction, semanticAbiAdapter };

export function analyzeDecodedSemanticFunction(input = {}, options = {}) {
  return analyzeSharedSemanticFunction({
    ...input,
    architecture: input.architecture ?? 'x86_64',
    analysisVersion: input.analysisVersion ?? X86_SEMANTIC_FUNCTION_ANALYSIS_VERSION,
  }, options);
}
