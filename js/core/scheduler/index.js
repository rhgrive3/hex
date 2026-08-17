import { ResourceBudget, BudgetExceededError } from '../budgets/index.js';

export const ANALYSIS_SCHEDULER_VERSION = 'hex-analysis-scheduler-v1';
export const ANALYSIS_PRIORITY = Object.freeze({
  foreground:0,
  current:1,
  prefetch:2,
  background:3,
  maintenance:4,
});

export class SchedulerCycleError extends Error {
  constructor(path) {
    super(`Artifact dependency cycle: ${path.join(' -> ')}`);
    this.name = 'SchedulerCycleError';
    this.code = 'artifact-dependency-cycle';
    this.path = path;
  }
}

export class SchedulerDependencyError extends Error {
  constructor(artifactId, cause) {
    super(`Dependency failed for ${artifactId}: ${String(cause?.message || cause)}`);
    this.name = 'SchedulerDependencyError';
    this.code = 'artifact-dependency-failed';
    this.artifactId = artifactId;
    this.cause = cause;
  }
}

function priorityValue(value) {
  if (typeof value === 'string' && Object.hasOwn(ANALYSIS_PRIORITY, value)) return ANALYSIS_PRIORITY[value];
  const n = Number(value ?? ANALYSIS_PRIORITY.current);
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('analysis-priority-invalid');
  return n;
}

function abortError(signal) {
  return signal?.reason || new DOMException('Aborted', 'AbortError');
}

function waitForConsumer(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, abortError(signal));
    signal.addEventListener('abort', onAbort, { once:true });
    promise.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

export class AnalysisScheduler {
  constructor({ store, maxConcurrency = 2, starvationInterval = 8, defaultBudget = {} } = {}) {
    if (!store) throw new TypeError('artifact-store-required');
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency <= 0) throw new TypeError('scheduler-max-concurrency-invalid');
    this.store = store;
    this.maxConcurrency = maxConcurrency;
    this.starvationInterval = Math.max(1, Number(starvationInterval) || 8);
    this.defaultBudget = defaultBudget;
    this.inflight = new Map();
    this.queue = [];
    this.running = 0;
    this.dispatchEpoch = 0;
    this.dag = new Map();
    this.states = new Map();
    this.metrics = {
      requests:0, cacheHits:0, producerInvocations:0, coalescedRequests:0,
      queueOperations:0, completedJobs:0, failedJobs:0, cancelledJobs:0,
      budgetExhaustions:0, dependencyFailures:0, cycleErrors:0,
    };
  }

  request(request) {
    return this.#request(request, []);
  }

  #request(request, ancestry) {
    const descriptor = request?.descriptor;
    const artifactId = String(descriptor?.artifactId || '');
    if (!artifactId) return Promise.reject(new TypeError('artifact-request-descriptor-required'));
    this.metrics.requests++;
    if (ancestry.includes(artifactId)) {
      this.metrics.cycleErrors++;
      return Promise.reject(new SchedulerCycleError([...ancestry, artifactId]));
    }

    const existing = this.inflight.get(artifactId);
    if (existing) {
      this.metrics.coalescedRequests++;
      return waitForConsumer(existing.promise, request.signal);
    }

    const controller = new AbortController();
    const externalSignal = request.signal || null;
    const onAbort = () => controller.abort(externalSignal.reason || new DOMException('Aborted', 'AbortError'));
    if (externalSignal?.aborted) onAbort();
    else externalSignal?.addEventListener('abort', onAbort, { once:true });

    const task = {
      artifactId,
      descriptor,
      request,
      controller,
      priority:priorityValue(request.priority),
      enqueuedEpoch:null,
      state:'waiting-dependency',
      resolve:null,
      reject:null,
      promise:null,
    };
    task.promise = this.#executeDependenciesThenQueue(task, [...ancestry, artifactId])
      .finally(() => {
        externalSignal?.removeEventListener('abort', onAbort);
        if (this.inflight.get(artifactId) === task) this.inflight.delete(artifactId);
      });
    this.inflight.set(artifactId, task);
    return waitForConsumer(task.promise, externalSignal);
  }

  async #executeDependenciesThenQueue(task, ancestry) {
    const dependencies = Array.isArray(task.request.dependencies) ? task.request.dependencies : [];
    const dependencyIds = dependencies.map((dependency) => String(dependency?.descriptor?.artifactId || '')).filter(Boolean).sort();
    this.dag.set(task.artifactId, Object.freeze(dependencyIds));
    this.states.set(task.artifactId, 'waiting-dependency');

    const dependencyResults = [];
    try {
      for (const dependency of dependencies) {
        if (task.controller.signal.aborted) throw abortError(task.controller.signal);
        dependencyResults.push(await this.#request(dependency, ancestry));
      }
    } catch (error) {
      if (error?.name === 'AbortError' || task.controller.signal.aborted) {
        this.metrics.cancelledJobs++;
        this.states.set(task.artifactId, 'cancelled');
        throw abortError(task.controller.signal);
      }
      if (error instanceof SchedulerCycleError) throw error;
      this.metrics.dependencyFailures++;
      this.states.set(task.artifactId, 'failed');
      throw new SchedulerDependencyError(task.artifactId, error);
    }

    if (task.controller.signal.aborted) {
      this.metrics.cancelledJobs++;
      this.states.set(task.artifactId, 'cancelled');
      throw abortError(task.controller.signal);
    }

    const cached = await this.store.get(task.descriptor, { signal:task.controller.signal });
    if (cached.status === 'hit') {
      this.metrics.cacheHits++;
      this.states.set(task.artifactId, 'completed');
      return { ...cached, state:'completed', reused:true };
    }

    return new Promise((resolve, reject) => {
      task.resolve = resolve;
      task.reject = reject;
      task.dependencyResults = dependencyResults;
      task.state = 'ready';
      task.enqueuedEpoch = this.dispatchEpoch;
      this.states.set(task.artifactId, 'ready');
      this.queue.push(task);
      this.metrics.queueOperations++;
      this.#pump();
    });
  }

  #effectivePriority(task) {
    const age = Math.max(0, this.dispatchEpoch - task.enqueuedEpoch);
    return Math.max(0, task.priority - Math.floor(age / this.starvationInterval));
  }

  #pump() {
    while (this.running < this.maxConcurrency && this.queue.length) {
      this.queue.sort((a, b) => {
        const pa = this.#effectivePriority(a), pb = this.#effectivePriority(b);
        return pa - pb || a.artifactId.localeCompare(b.artifactId);
      });
      const task = this.queue.shift();
      this.metrics.queueOperations++;
      this.dispatchEpoch++;
      if (task.controller.signal.aborted) {
        this.metrics.cancelledJobs++;
        this.states.set(task.artifactId, 'cancelled');
        task.reject(abortError(task.controller.signal));
        continue;
      }
      this.running++;
      task.state = 'running';
      this.states.set(task.artifactId, 'running');
      this.#run(task).finally(() => {
        this.running--;
        this.#pump();
      });
    }
  }

  async #run(task) {
    const signal = task.controller.signal;
    const budget = task.request.budget instanceof ResourceBudget
      ? task.request.budget
      : new ResourceBudget({ ...this.defaultBudget, ...(task.request.budget || {}) }, { signal });
    try {
      budget.checkCancelled();
      if (typeof task.request.produce !== 'function') throw new TypeError('artifact-producer-required');
      this.metrics.producerInvocations++;
      const payload = await task.request.produce({
        descriptor:task.descriptor,
        artifactId:task.artifactId,
        dependencies:task.dependencyResults,
        signal,
        budget,
      });
      budget.checkCancelled();
      const published = await this.store.publish(task.descriptor, payload, {
        signal,
        completeness:task.request.completeness ?? 'complete',
        validate:task.request.validate,
        creation:task.request.creation,
      });
      budget.checkCancelled();
      this.metrics.completedJobs++;
      this.states.set(task.artifactId, 'completed');
      task.resolve({ ...published, state:'completed', reused:false, budget:budget.snapshot() });
    } catch (error) {
      if (error instanceof BudgetExceededError) {
        this.metrics.budgetExhaustions++;
        this.states.set(task.artifactId, 'budget-exhausted');
      } else if (error?.name === 'AbortError' || signal.aborted) {
        this.metrics.cancelledJobs++;
        this.states.set(task.artifactId, 'cancelled');
      } else {
        this.metrics.failedJobs++;
        this.states.set(task.artifactId, 'failed');
      }
      task.reject(error);
    }
  }

  cancel(artifactId, reason = new DOMException('Cancelled', 'AbortError')) {
    const task = this.inflight.get(String(artifactId));
    if (!task) return false;
    task.controller.abort(reason);
    const index = this.queue.indexOf(task);
    if (index >= 0) {
      this.queue.splice(index, 1);
      this.metrics.queueOperations++;
      this.metrics.cancelledJobs++;
      this.states.set(task.artifactId, 'cancelled');
      task.reject(reason);
    }
    return true;
  }

  dependencyIds(artifactId) { return this.dag.get(String(artifactId)) || Object.freeze([]); }
  state(artifactId) { return this.states.get(String(artifactId)) || 'unknown'; }

  stats() {
    return Object.freeze({
      schedulerVersion:ANALYSIS_SCHEDULER_VERSION,
      running:this.running,
      queued:this.queue.length,
      inflight:this.inflight.size,
      dagNodes:this.dag.size,
      ...this.metrics,
    });
  }
}
