import {
  CANONICAL_ADDRESS_DERIVATION_VERSION,
  GENERIC_ROOT_DESCRIPTOR_KINDS,
  canonicalAddressProofToRegionEvidence,
  deriveCanonicalAddressProof as deriveCanonicalAddressProofCore,
  sameCanonicalAddressProof,
} from './canonical-address-v2-core.js';

export {
  CANONICAL_ADDRESS_DERIVATION_VERSION,
  GENERIC_ROOT_DESCRIPTOR_KINDS,
  canonicalAddressProofToRegionEvidence,
  sameCanonicalAddressProof,
};

/*
 * Generic SSA represents an unseeded incoming physical state with an explicit
 * `undef` definition carrying proof.kind === `implicit-undef`. For address
 * derivation that sentinel means "no reaching semantic write exists on this
 * path", not "a prior clobber may have happened". Treat only that proven seed as
 * a symbolic entry definition while deriving addresses.
 *
 * This does not manufacture a concrete pointer or value: root identity still
 * comes from the state variable / architecture-neutral root descriptor, and
 * unknown definitions, unknown calls, clobbers, and non-exact PHIs remain
 * unknown. The normalization is local to canonical-address proof construction;
 * the canonical SSA contract itself is left untouched.
 */
function addressProofOptions(options = {}) {
  const definitions = options?.ssa?.definitions;
  if (!Array.isArray(definitions)
      || !definitions.some((definition) => definition?.kind === 'undef' && definition?.proof?.kind === 'implicit-undef')) {
    return options;
  }
  return {
    ...options,
    ssa: {
      ...options.ssa,
      definitions: definitions.map((definition) =>
        definition?.kind === 'undef' && definition?.proof?.kind === 'implicit-undef'
          ? { ...definition, kind: 'entry' }
          : definition),
    },
  };
}

export {
  defaultRootEntityId,
  normalizeRootIdentity,
} from './canonical-address-v2-core.js';

export function deriveCanonicalAddressProof(ir, addressValueId, options = {}) {
  return deriveCanonicalAddressProofCore(ir, addressValueId, addressProofOptions(options));
}

export function deriveCanonicalRegionEvidence(ir, addressValueId, options = {}) {
  return canonicalAddressProofToRegionEvidence(deriveCanonicalAddressProof(ir, addressValueId, options));
}
