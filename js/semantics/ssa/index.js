export {
  SEMANTIC_SSA_CONTRACT_VERSION,
  SEMANTIC_SSA_DEFINITION_KINDS,
  SEMANTIC_SSA_DEFAULT_BUDGET,
  createSemanticSsaContract,
} from './contract.js';
export {
  SEMANTIC_SSA_BUILD_VERSION,
  SEMANTIC_SSA_BUILD_DEFAULT_BUDGET,
  buildSemanticSsa,
} from './build.js';
export {
  getSsaDefinition,
  getSsaDefinitionById,
  getSsaUse,
  getDefinitionForUse,
  getUsesForDefinition,
  getUsesForValue,
  getDefinitionsForVariable,
  getPhiDefinitions,
  getPhiIncoming,
  getSsaUsesForSourceEntity,
  getSsaUseForSemanticValue,
  getSsaDefinitionForSemanticValue,
  createSsaQueryIndex,
} from './queries.js';
export { validateSemanticSsa, assertSemanticSsaValid } from './validate.js';
