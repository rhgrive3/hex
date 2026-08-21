import { assertAnalysisSnapshot, createAnalysisSnapshot, AnalysisSnapshotStaleError } from "./snapshot.js";

function artifactVersionsEqual(left = {}, right = {}) {
  const a = Object.keys(left || {}).sort();
  const b = Object.keys(right || {}).sort();
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    const key = a[index];
    if (key !== b[index] || String(left[key]) !== String(right[key])) return false;
  }
  return true;
}

function sameSnapshotIdentity(snapshot, current) {
  return String(current.binaryId) === String(snapshot.binaryId)
    && Number(current.projectRevision ?? 0) === Number(snapshot.projectRevision ?? 0)
    && Number(current.analysisEpoch) === Number(snapshot.analysisEpoch)
    && artifactVersionsEqual(current.artifactVersions, snapshot.artifactVersions);
}

function aborted(options) {
  if (!options?.signal?.aborted) return;
  const err = options.signal.reason instanceof Error ? options.signal.reason : new Error("AbortError");
  err.name = "AbortError";
  throw err;
}

function unavailable(method) {
  return {
    value: null,
    status: {
      completeness: "unsupported",
      reason: `analysis-query-adapter-${method}-unavailable`,
    },
  };
}

export class AnalysisQueryAPI {
  constructor(adapter) {
    if (!adapter || typeof adapter.currentIdentity !== "function") {
      throw new TypeError("analysis-query-adapter-required");
    }
    this.adapter = adapter;
  }

  async snapshot(options = {}) {
    aborted(options);
    const id = await this.adapter.currentIdentity(options);
    return createAnalysisSnapshot(id);
  }

  async #validateAndCheckStale(snapshot, options) {
    assertAnalysisSnapshot(snapshot);
    aborted(options);
    const current = await this.adapter.currentIdentity(options);
    if (!sameSnapshotIdentity(snapshot, current)) {
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
    aborted(options);
    const currentAfter = await this.adapter.currentIdentity(options);
    if (!sameSnapshotIdentity(snapshot, currentAfter)) {
      throw new AnalysisSnapshotStaleError("Snapshot became stale during query", {
        snapshotId: snapshot.snapshotId,
        expectedEpoch: snapshot.analysisEpoch,
        currentEpoch: currentAfter.analysisEpoch,
      });
    }

    const completeness = result?.status?.completeness ?? result?.completeness ?? "partial";
    const value = result?.value !== undefined ? result.value : result;
    const status = Object.freeze({
      ...(result?.status && typeof result.status === "object" ? result.status : {}),
      completeness,
    });
    return Object.freeze({
      snapshotId: snapshot.snapshotId,
      analysisEpoch: snapshot.analysisEpoch,
      completeness,
      value,
      status,
      page: result?.page ?? null,
      cost: result?.cost ?? status.cost ?? null,
    });
  }

  async #query(method, snapshot, args, options = {}) {
    return this.#wrapResult(
      snapshot,
      () => typeof this.adapter[method] === "function"
        ? this.adapter[method](snapshot, ...args, options)
        : unavailable(method),
      options,
    );
  }

  async binaryInfo(snapshot, options = {}) {
    return this.#query("binaryInfo", snapshot, [], options);
  }

  async functions(snapshot, query = {}, page = {}, options = {}) {
    return this.#query("functions", snapshot, [query, page], options);
  }

  async function(snapshot, functionId, options = {}) {
    return this.#query("functionById", snapshot, [functionId], options);
  }

  async instructions(snapshot, range, page = {}, options = {}) {
    return this.#query("instructions", snapshot, [range, page], options);
  }

  async semanticIR(snapshot, functionId, options = {}) {
    return this.#query("semanticIR", snapshot, [functionId], options);
  }

  async cfg(snapshot, functionId, options = {}) {
    return this.#query("cfg", snapshot, [functionId], options);
  }

  async callers(snapshot, functionId, page = {}, options = {}) {
    return this.#query("callers", snapshot, [functionId, page], options);
  }

  async callees(snapshot, functionId, page = {}, options = {}) {
    return this.#query("callees", snapshot, [functionId, page], options);
  }

  async xrefs(snapshot, entityId, page = {}, options = {}) {
    return this.#query("xrefs", snapshot, [entityId, page], options);
  }

  async types(snapshot, scope, page = {}, options = {}) {
    return this.#query("types", snapshot, [scope, page], options);
  }

  async evidence(snapshot, query = {}, page = {}, options = {}) {
    return this.#query("evidence", snapshot, [query, page], options);
  }

  async decompile(snapshot, functionId, options = {}) {
    return this.#query("decompile", snapshot, [functionId], options);
  }

  async search(snapshot, query, page = {}, options = {}) {
    return this.#query("search", snapshot, [query, page], options);
  }

  async causalPath(snapshot, source, sink, options = {}) {
    return this.#query("causalPath", snapshot, [source, sink], options);
  }
}
