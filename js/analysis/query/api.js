import { assertAnalysisSnapshot, createAnalysisSnapshot, AnalysisSnapshotStaleError } from "./snapshot.js";

export class AnalysisQueryAPI {
  constructor(adapter) {
    if (!adapter || typeof adapter.currentIdentity !== "function") {
      throw new TypeError("analysis-query-adapter-required");
    }
    this.adapter = adapter;
  }

  async snapshot(options = {}) {
    if (options.signal?.aborted) {
      const err = new Error("AbortError");
      err.name = "AbortError";
      throw err;
    }
    const id = await this.adapter.currentIdentity(options);
    return createAnalysisSnapshot(id);
  }

  async #validateAndCheckStale(snapshot, options) {
    assertAnalysisSnapshot(snapshot);
    if (options?.signal?.aborted) {
      const err = new Error("AbortError");
      err.name = "AbortError";
      throw err;
    }
    const current = await this.adapter.currentIdentity(options);
    if (current.binaryId !== snapshot.binaryId || current.analysisEpoch !== snapshot.analysisEpoch) {
      throw new AnalysisSnapshotStaleError("Snapshot is stale before query", {
        snapshotId: snapshot.snapshotId,
        expectedEpoch: snapshot.analysisEpoch,
        currentEpoch: current.analysisEpoch,
      });
    }
  }

  async #wrapResult(snapshot, executeFn, options) {
    await this.#validateAndCheckStale(snapshot, options);
    const result = await executeFn();
    if (options?.signal?.aborted) {
      const err = new Error("AbortError");
      err.name = "AbortError";
      throw err;
    }
    const currentAfter = await this.adapter.currentIdentity(options);
    if (currentAfter.binaryId !== snapshot.binaryId || currentAfter.analysisEpoch !== snapshot.analysisEpoch) {
      throw new AnalysisSnapshotStaleError("Snapshot became stale during query", {
        snapshotId: snapshot.snapshotId,
        expectedEpoch: snapshot.analysisEpoch,
        currentEpoch: currentAfter.analysisEpoch,
      });
    }

    const completeness = result?.status?.completeness ?? result?.completeness ?? "partial";
    const value = result?.value !== undefined ? result.value : result;
    return Object.freeze({
      snapshotId: snapshot.snapshotId,
      analysisEpoch: snapshot.analysisEpoch,
      completeness,
      value,
    });
  }

  async function(snapshot, functionId, options = {}) {
    return this.#wrapResult(snapshot, () => this.adapter.functionById(snapshot, functionId, options), options);
  }

  async semanticIR(snapshot, functionId, options = {}) {
    return this.#wrapResult(snapshot, () => this.adapter.semanticIR(snapshot, functionId, options), options);
  }

  async cfg(snapshot, functionId, options = {}) {
    return this.#wrapResult(snapshot, () => this.adapter.cfg(snapshot, functionId, options), options);
  }
}
