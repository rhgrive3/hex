export const ANALYSIS_SCHEDULER_VERSION = 'hex-analysis-scheduler-v1';
export const ANALYSIS_PRIORITY = Object.freeze({ foreground:0, current:1, prefetch:2, background:3, maintenance:4 });

export class SchedulerCycleError extends Error {
  constructor(path) { super(`Artifact dependency cycle: ${path.join(' -> ')}`); this.name='SchedulerCycleError'; this.code='artifact-dependency-cycle'; this.path=path; }
}
export class SchedulerDependencyError extends Error {
  constructor(artifactId, cause) { super(`Dependency failed for ${artifactId}: ${String(cause?.message || cause)}`); this.name='SchedulerDependencyError'; this.code='artifact-dependency-failed'; this.artifactId=artifactId; this.cause=cause; }
}
export class SchedulerDependencyIdentityError extends Error {
  constructor(artifactId, expected, actual) {
    super(`Artifact dependency identity mismatch for ${artifactId}`);
    this.name='SchedulerDependencyIdentityError'; this.code='artifact-dependency-identity-mismatch';
    this.artifactId=artifactId; this.expected=expected; this.actual=actual;
  }
}

// P4-7 canonical cutover: there is exactly one production scheduler implementation.
// Keep the frozen public contract above and re-export the hardened P4-2 implementation.
export { AnalysisScheduler } from './analysis-scheduler.js';
export { createSchedulerEventBuffer } from './lifecycle-events.js';
