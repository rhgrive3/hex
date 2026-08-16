export { ArchitectureAdapter, architectureAdapter, architectureCapability, registerArchitectureAdapter } from '../architecture/index.js';
export { CachedByteSource, InstrumentedByteSource, ByteSourceCancelledError } from '../bytesource/cached.js';
export { AnalysisCache, ANALYSIS_CACHE_SCHEMA } from '../cache/analysis-cache.js';
export { createHexProject, serializeHexProject, parseHexProject, tryParseHexProject, importHexProject, exportHexProject, HEX_PROJECT_VERSION } from '../project/index.js';
export { fingerprintFunction, compareFingerprints, diffFunctions } from '../diff/index.js';
export { KnowledgeDB, fingerprintVendors } from '../knowledge/index.js';
export { hashByteSource, hashBytes } from './hash.js';
export {
  ARCHITECTURE_LEVELS, FORMAT_LEVELS, MANAGED_LEVELS,
  ARCHITECTURE_FEATURE_LEVEL, FORMAT_FEATURE_LEVEL, MANAGED_FEATURE_LEVEL,
  CAPABILITY_STATUS,
  architectureMaturity, formatMaturity, managedMaturity,
  capabilityDisplay, currentSupportMatrix, featureAvailable,
} from './capability-maturity.js';
export { supportTruthForImage, supportDisplayForTruth } from './support-capability.js';
export {
  PlatformPluginRegistry, platformPlugins,
  registerFormat, registerArchitecture, registerAnalyzer, registerKnowledgeProvider,
  registerViewContribution, registerGoalProvider,
} from './plugin-api.js';