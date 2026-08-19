/* Thin conflict-resistant wrapper around the exact main decompiler snapshot.
 * `decompile-base.js` is a byte-for-byte blob copy of the decompile.js that
 * existed at this branch base. On rebase, refresh that one blob from the new
 * main decompile.js; this wrapper should normally stay conflict-free. */
import { decompile as baseDecompile } from './decompile-base.js';
import { lowerArm64RawAssembly } from './decompiler/arm64-extra-semantics.js';

export * from './decompile-base.js';

export function decompile(model, opts = {}) {
  return lowerArm64RawAssembly(baseDecompile(model, opts));
}
