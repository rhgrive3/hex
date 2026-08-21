import { stableDigest } from "../../core/identity/index.js";
import { assertAnalysisSnapshot, createAnalysisSnapshot, AnalysisSnapshotStaleError } from "./snapshot.js";

function artifactVersionsEqual(left = {}, right = {}) {
  try { return stableDigest(left || {}) === stableDigest(right || {}); }
  catch { return false; }
}

function sameSnapshotIdentity(snapshot, current) {
  const binaryId = String(current?.binaryId ?? "").trim();
  const projectRevision = Number(current?.projectRevision);
  const analysisEpoch = Number(current?.analysisEpoch);
  return binaryId === snapshot.binaryId
    && Number.isSafeInteger(projectRevision) && projectRevision >= 0 && projectRevision === snapshot.projectRevision
    && Number.isSafeInteger(analysisEpoch) && analysisEpoch >= 0 && analysisEpoch === snapshot.analysisEpoch
    && artifactVersionsEqual(current?.artifactVersions, snapshot.artifactVersions);
}

function abortError(reason = null) {
  if (reason instanceof Error) return reason;
  const error = new Error("AbortError");
  error.name = "AbortError";
  return error;
}

export class AnalysisQueryAPI {
  constructor(adapter) {
    if (!adapter || typeof adapter.currentIdentity !== "function") throw new TypeError("analysis-query-adapter-required");
    this.adapter = adapter;
  }

  async snapshot(options = {}) {
    if (options.signal?.aborted) throw abortError(options.signal.reason);
    return createAnalysisSnapshot(await this.adapter.currentIdentity(options));
  }

  async #validateAndCheckStale(snapshot, options) {
    assertAnalysisSnapshot(snapshot);
    if (options?.signal?.aborted) throw abortError(options.signal.reason);
    const current = await this.adapter.currentIdentity(options);
    if (!sameSnapshotIdentity(snapshot, current)) {
      throw new AnalysisSnapshotStaleError("Snapshot is stale before query", {
        snapshotId: snapshot.snapshotId,
        expectedEpoch: snapshot.analysisEpoch,
        currentEpoch: current?.analysisEpoch,
      });
    }
  }

  async #wrapResult(snapshot, executeFn, options) {
    await this.#validateAndCheckStale(snapshot, options);
    const result = await executeFn();
    if (options?.signal?.aborted) throw abortError(options.signal.reason);
    const currentAfter = await this.adapter.currentIdentity(options);
    if (!sameSnapshotIdentity(snapshot, currentAfter)) {
      throw new AnalysisSnapshotStaleError("Snapshot became stale during query", {
        snapshotId: snapshot.snapshotId,
        expectedEpoch: snapshot.analysisEpoch,
        currentEpoch: currentAfter?.analysisEpoch,
      });
    }
    const completeness = result?.status?.completeness ?? result?.completeness ?? "partial";
    const value = result?.value !== undefined ? result.value : result;
    return Object.freeze({ snapshotId: snapshot.snapshotId, analysisEpoch: snapshot.analysisEpoch, completeness, value });
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
