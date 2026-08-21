import { DebugAdapterError } from "../debug/adapter.js";

export function hasProvenRuntimeStaticIdentity(module) {
  return module?.binaryId != null && (
    module?.identityState === "exact" ||
    module?.identityState === "resolved" ||
    (Array.isArray(module?.identityEvidenceIds) && module.identityEvidenceIds.length > 0)
  );
}

export function normalizeRuntimeModuleBinding(module, { bindingKey: explicitKey, loadedSequence } = {}) {
  const rawKey = explicitKey ?? module?.bindingKey ?? module?.key;
  const key = String(rawKey ?? "").trim();
  if (!key) {
    throw new DebugAdapterError("runtime-invalid-module-binding-key", "runtime module binding key is required");
  }

  const runtimeBase = module?.runtimeBase ?? module?.base;
  const runtimeSize = module?.runtimeSize ?? module?.size;
  const staticBase = module?.staticBase ?? module?.imageBase ?? null;
  const pathHint = module?.pathHint ?? module?.path ?? module?.name ?? null;
  const buildIdentity = module?.buildIdentity ?? module?.uuid ?? null;
  const identityEvidenceIds = Object.freeze(Array.isArray(module?.identityEvidenceIds) ? [...module.identityEvidenceIds] : []);

  const trusted = hasProvenRuntimeStaticIdentity(module);
  const binaryId = trusted ? (module?.binaryId ?? null) : null;
  const sliceId = trusted ? (module?.sliceId ?? null) : null;
  const imageId = trusted ? (module?.imageId ?? null) : null;
  const identityState = trusted ? (module?.identityState ?? "resolved") : "unresolved";

  const result = {
    bindingKey: key,
    runtimeBase,
    runtimeSize,
    staticBase,
    pathHint,
    binaryId,
    sliceId,
    imageId,
    buildIdentity,
    identityState,
    identityEvidenceIds,
  };
  if (loadedSequence !== undefined) {
    result.loadedSequence = loadedSequence;
  }
  return Object.freeze(result);
}
