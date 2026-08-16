/*
 * Phase 1 compatibility facade.
 *
 * The active legacy ARM64 semantic implementation is intentionally frozen in
 * architecture/compat so Phase 1 can separate target/ABI contracts without
 * changing ARM64 IR/SSA/MemorySSA behavior. New AAPCS64 classification lives in
 * targets/abi; MachineEffects/Semantic IR v2 are later phases.
 */
export * from './architecture/compat/ir-core-arm64-aapcs64-v1.js';
export { classifyAAPCS64Arguments as classifyCallArguments } from './targets/abi/aapcs64.js';
