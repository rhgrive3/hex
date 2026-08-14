/* Backward-compatible type facade plus Semantic IR type recovery. */
export * from './types-legacy.js';
export { inferSemanticTypes, semanticSignature, typeNameOf, mergeRecoveredTypes } from './decompiler/type-recovery.js';
