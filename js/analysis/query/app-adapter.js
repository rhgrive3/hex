export function createAppAnalysisQueryAdapter(app) {
  return {
    async currentIdentity(options = {}) {
      const binaryId = app?.store?.fileInfo?.sha256 ?? "unbound";
      const projectRevision = app?.store?.project?.revision ?? 0;
      const analysisEpoch = app?.analysisEpoch ?? 0;
      const artifactVersions = {};
      return {
        binaryId,
        projectRevision,
        artifactVersions,
        analysisEpoch,
      };
    },

    async functionById(snapshot, functionId, options = {}) {
      if (typeof app?.analyzeFunction === "function") {
        return app.analyzeFunction(functionId, options);
      }
      return { functionId, status: { completeness: "complete" } };
    },

    async semanticIR(snapshot, functionId, options = {}) {
      if (typeof app?.getSemanticIR === "function") {
        return app.getSemanticIR(functionId, options);
      }
      return { functionId, nodes: [], status: { completeness: "complete" } };
    },

    async cfg(snapshot, functionId, options = {}) {
      if (typeof app?.getCFG === "function") {
        return app.getCFG(functionId, options);
      }
      return { functionId, blocks: [], status: { completeness: "complete" } };
    },
  };
}
