export const SANDBOX_MODE = 'sandbox-v2';
export const LEGACY_MODE = 'legacy-light-dom';

/**
 * Resolve the ChatGPT embed mode from the userscript realm only.
 *
 * Page-origin storage is intentionally not consulted here. A ChatGPT page
 * script must not be able to persistently downgrade Hex out of its opaque
 * sandbox. The legacy mode remains available only through the explicit
 * userscript-realm override used for emergency rollback.
 */
export function readTrustedEmbedMode(globalObject = globalThis) {
  try {
    return globalObject?.__HEX_EMBED_MODE__ === LEGACY_MODE ? LEGACY_MODE : SANDBOX_MODE;
  } catch {
    return SANDBOX_MODE;
  }
}
