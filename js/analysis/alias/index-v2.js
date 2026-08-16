export {
  REGION_ALIAS_FLOOR_VERSION,
  classifySemanticMemoryRegion,
  deriveMemoryRegion,
  isPreciseMemoryRegion,
  sameMemoryRegionIdentity,
} from './regions-v2.js';

export {
  ALIAS_RELATIONS,
  aliasMemoryRegions,
  effectSummaryAliasRelation,
  unknownStoreAliasRelation,
  unknownStoreClobbersRegion,
} from './legacy-safety-floor.js';
