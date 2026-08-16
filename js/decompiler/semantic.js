export * from './semantic-core.js';

import { irFor } from '../ir.js';
import { decompileSemantic as decompileSemanticCore } from './semantic-core.js';

function irOptionsFromDecompilerOptions(opts = {}) {
  return {
    rowOfAddress: opts.rowOfAddress,
    returnType: opts.returnType,
    functionPrototype: opts.functionPrototype,
    prototype: opts.prototype,
    returnClass: opts.returnClass,
    returnBits: opts.returnBits,
    returnsValue: opts.returnsValue,
    decoderSemanticVersion: opts.decoderSemanticVersion,
    binaryId: opts.binaryId,
    sliceId: opts.sliceId,
    abiAdapter: opts.abiAdapter,
    rootDescriptorProvider: opts.rootDescriptorProvider,
    regionOptions: opts.regionOptions,
    semanticIrOptions: opts.semanticIrOptions,
    ssaOptions: opts.ssaOptions,
    memorySsaOptions: opts.memorySsaOptions,
    compatOptions: opts.compatOptions,
    signal: opts.signal,
  };
}

/**
 * Preserve function-level ABI/prototype evidence when the decompiler asks the
 * Semantic IR facade to build IR. The prior facade forwarded only rowOfAddress,
 * so v2 compatibility could not project an explicit return value at multi-block
 * O0 epilogues even though the caller had already supplied returnType.
 */
export function decompileSemantic(model, opts = {}) {
  const ir = opts.ir || irFor(model, irOptionsFromDecompilerOptions(opts));
  return decompileSemanticCore(model, { ...opts, ir });
}
