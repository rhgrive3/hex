export const MODULE_BOUNDARY_POLICY_VERSION = "hex-module-boundaries-v1";

export const moduleBoundaryPolicy = {
  policyVersion: MODULE_BOUNDARY_POLICY_VERSION,
  classify(filePath) {
    const normalized = filePath.replace(/\\/g, "/");
    if (normalized.startsWith("js/semantics/compat/")) return "semantic-compat";
    if (normalized.startsWith("js/semantics/")) return "canonical-semantics";
    if (
      normalized === "js/ir.js" ||
      normalized === "js/ir-core.js" ||
      normalized === "js/cfg.js" ||
      normalized === "js/dataflow.js" ||
      normalized === "js/analyze.js"
    ) {
      return "legacy-semantic-facade";
    }
    return null;
  },
  isForbidden(importerGroup, targetGroup) {
    if (importerGroup === "canonical-semantics" && targetGroup === "semantic-compat") {
      return "canonical-semantics->semantic-compat";
    }
    if (importerGroup === "canonical-semantics" && targetGroup === "legacy-semantic-facade") {
      return "canonical-semantics->legacy-semantic-facade";
    }
    return null;
  },
};
