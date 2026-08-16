import {
  architectureMaturity,
  capabilityDisplay,
  formatMaturity,
  managedMaturity,
  normalizeArchitectureCapabilityId,
} from './capability-maturity.js';

function decoderAvailable(architecture, engine) {
  const id = normalizeArchitectureCapabilityId(architecture);
  if (id === 'arm64e') return !!engine.arm64e || !!engine.arm64;
  return !!engine[id];
}

export function supportTruthForImage(image, options = {}) {
  const engine = options.engine || {};
  const architecture = architectureMaturity(image?.arch, {
    decoderAvailable: decoderAvailable(image?.arch, engine),
  });
  const format = formatMaturity(image?.format);
  const managed = options.managedFrontend ? managedMaturity(options.managedFrontend) : null;
  return Object.freeze({ architecture, format, managed });
}

export function supportDisplayForTruth(truth) {
  return Object.freeze({
    architecture: capabilityDisplay(truth?.architecture),
    format: capabilityDisplay(truth?.format),
    managed: truth?.managed ? capabilityDisplay(truth.managed) : null,
  });
}
