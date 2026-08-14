export { ArchitectureAdapter, architectureAdapter, architectureCapability, registerArchitectureAdapter } from '../architecture/index.js';
export { CachedByteSource, InstrumentedByteSource, ByteSourceCancelledError } from '../bytesource/cached.js';
export { AnalysisCache, ANALYSIS_CACHE_SCHEMA } from '../cache/analysis-cache.js';
export { createHexProject, serializeHexProject, parseHexProject, tryParseHexProject, importHexProject, exportHexProject, HEX_PROJECT_VERSION } from '../project/index.js';
export { fingerprintFunction, compareFingerprints, diffFunctions } from '../diff/index.js';
export { KnowledgeDB, fingerprintVendors } from '../knowledge/index.js';
export { hashByteSource, hashBytes } from './hash.js';
export {
  PlatformPluginRegistry, platformPlugins,
  registerFormat, registerArchitecture, registerAnalyzer, registerKnowledgeProvider,
  registerViewContribution, registerGoalProvider,
} from './plugin-api.js';
