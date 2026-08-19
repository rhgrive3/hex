import { parseELF as parseELFBase } from './elf.js';
import { attachAarch64GnuPropertyEvidence } from './elf-gnu-property.js';

/**
 * Public ELF loader projection. The base parser remains the structural oracle;
 * architecture-specific GNU property evidence is attached afterwards so loader
 * policy is available without being confused with actual runtime page state.
 */
export function parseELF(input, options = {}) {
  const image = parseELFBase(input, options);
  return attachAarch64GnuPropertyEvidence(image, input, options.gnuProperty || {});
}

export { parseAarch64GnuProperty, attachAarch64GnuPropertyEvidence } from './elf-gnu-property.js';
