/* Conflict-resistant public panel boundary.
 * The historical panel implementation remains byte-for-byte in panels-base.js.
 * Architecture-neutral function discovery/summary are explicit overrides so
 * they can consume AnalysisQueryAPI without duplicating the rest of the UI. */
export * from './panels-base.js';
export { showFunctions, showFunctionSummary } from './ui/panels/function-analysis.js';
