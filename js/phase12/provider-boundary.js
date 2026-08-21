import { deepFreeze } from '../core/identity/index.js';
import { validateProviderOutput } from './package-envelope.js';

/** Validate provider data before it can become an ArtifactStore candidate. */
export function validatePhase12ProviderResult(result, options = {}) {
  const checked = validateProviderOutput(result, options);
  if (!checked.ok) return checked;
  return { ok: true, value: deepFreeze({ ...checked.value, authority: 'L1-external-evidence', textIsUntrustedData: true, persisted: false }) };
}

export function providerFailure(result) {
  return Object.freeze({ status: 'rejected', reason: result?.code || result?.error || 'provider-output-invalid', authority: 'none', persisted: false });
}
