import { functionSeed } from './model.js';
import { executableELFRange } from './elf-mapping.js';

function normalizePresence(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (['present','required','always','zero-valid','entrypoint-required'].includes(text)) return 'present';
  if (['absent','none','sentinel','no-entry','entrypoint-absent'].includes(text)) return 'absent';
  return 'auto';
}

function entrypointPresencePolicy(options = {}) {
  if (options.zeroEntrypointIsValid === true) return 'present';
  if (options.zeroEntrypointIsValid === false) return 'absent';
  if (options.platformProfile?.entrypointRequired === true || options.platformProfile?.zeroEntrypointValid === true) return 'present';
  if (options.platformProfile?.entrypointRequired === false || options.platformProfile?.zeroEntrypointValid === false) return 'absent';
  const explicit = options.entrypointPresence
    ?? options.platformEntrypointPresence
    ?? options.target?.entrypointPresence
    ?? options.platformProfile?.entrypointPresence
    ?? options.abiProfile?.entrypointPresence
    ?? null;
  const normalized = normalizePresence(explicit);
  if (normalized !== 'auto') return normalized;
  const platform = String(options.platform ?? options.target?.platform ?? options.platformProfile?.id ?? '').trim().toLowerCase();
  if (platform === 'bare-metal' || platform === 'baremetal' || platform === 'firmware') return 'present';
  return 'auto';
}

function executableFileBackedOwner(image, address) {
  const owner = executableELFRange(image, address, 1n, null);
  if (!owner) return null;
  return image.addressToOffset(address) == null ? null : owner;
}

/**
 * e_entry is an address field, not a JavaScript truthiness flag. Generic ELF
 * permits zero as a no-entry sentinel, while a platform ABI may define address
 * zero as a real entrypoint (for example a reset vector). Keep those states
 * separate and seed discovery only when presence and executable mapping agree.
 */
export function seedELFEntrypoint(image, { relocatable = false, options = {} } = {}) {
  image.metadata ||= {};
  if (relocatable) {
    image.metadata.entrypointPresence = 'not-applicable-relocatable';
    image.metadata.entrypointValid = null;
    return null;
  }
  if (image.entrypoint == null) {
    image.metadata.entrypointPresence = 'absent';
    image.metadata.entrypointValid = null;
    return null;
  }

  const address = BigInt(image.entrypoint);
  const zero = address === 0n;
  const policy = entrypointPresencePolicy(options);
  image.metadata.entrypointPresencePolicy = policy;

  if (zero && policy === 'absent') {
    image.metadata.entrypointPresence = 'absent-zero-sentinel';
    image.metadata.entrypointValid = null;
    image.metadata.entrypointEvidence = 'platform-entrypoint-policy';
    return null;
  }

  const owner = executableFileBackedOwner(image, address);
  if (!owner) {
    image.metadata.entrypointPresence = zero && policy === 'auto' ? 'ambiguous-zero-unmapped' : 'invalid-unmapped';
    image.metadata.entrypointValid = zero && policy === 'auto' ? null : false;
    image.metadata.entrypointEvidence = 'no-executable-file-backed-mapping';
    image.warnings.push(`ELF entrypoint 0x${address.toString(16)} is not inside an executable file-backed mapping`);
    return null;
  }

  if (zero && policy === 'auto') {
    image.metadata.entrypointPresence = 'ambiguous-zero';
    image.metadata.entrypointValid = null;
    image.metadata.entrypointEvidence = 'generic-elf-zero-sentinel-ambiguity';
    return null;
  }

  image.metadata.entrypointPresence = 'present';
  image.metadata.entrypointValid = true;
  image.metadata.entrypointEvidence = zero ? 'platform-zero-entrypoint-contract' : 'elf-entrypoint-executable-mapping';
  const seed = functionSeed(address, {
    source:'entrypoint',
    confidence:0.9,
    exactFunctionStart:true,
    functionStartEvidence:zero
      ? 'ELF platform contract permits concrete zero entrypoint with executable mapping'
      : 'ELF e_entry with executable file-backed mapping',
  });
  image.functions.push(seed);
  return seed;
}
