// Verified against the deployed capstone.js/capstone.wasm by
// tests/capstone-capability.mjs. If the bundled build changes, that test must
// fail before these capability claims can drift from the actual runtime.
export const DEPLOYED_CAPSTONE_SUPPORT = Object.freeze({
  arm64: true,
  x86_64: true,
});
