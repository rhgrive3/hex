/* Thin conflict-resistant API knowledge facade.
 * `blocks-base.js` is a byte-for-byte copy of the main `blocks.js` at the
 * branch snapshot. On rebase, refresh only that blob from current main. */
import { apiInfo as baseApiInfo } from './blocks-base.js';
import { extraApiInfo } from './api-cross-binary-families.js';

export * from './blocks-base.js';

export function apiInfo(name) {
  return baseApiInfo(name) || extraApiInfo(name);
}
