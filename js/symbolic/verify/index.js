/**
 * js/symbolic/verify/index.js
 *
 * Public entrypoint for Hex Verification subsystem:
 * queries, model validation, proof eligibility, vacuous proof guards,
 * and product proofs (Conditional Edge Feasibility).
 */

export * from './query.js';
export * from './validate-model.js';
export * from './eligibility.js';
export * from './preconditions.js';
export * from './edge-feasibility.js';
