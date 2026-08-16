export * from './semantic-core.js';

import { irFor, OP } from '../ir.js';
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

/*
 * Keep the public decompiler facade's historical runtime-model compatibility:
 * callers may supply the canonical runtime index directly, the ObjC model that
 * owns it, or the mixed Apple runtime aggregate. Normalize that evidence before
 * delegating so the split facade does not weaken issue #529 runtime wiring.
 */
function canonicalRuntimeOptions(opts = {}) {
  const objcRuntimeIndex = opts.objcRuntimeIndex || opts.objcModel || opts.appleRuntime?.objc || null;
  return objcRuntimeIndex === opts.objcRuntimeIndex ? opts : { ...opts, objcRuntimeIndex };
}

function declaredIntegerReturnBits(opts = {}) {
  const explicit = Number(opts.returnBits ?? opts.functionPrototype?.returnBits ?? opts.prototype?.returnBits ?? 0);
  if (Number.isSafeInteger(explicit) && explicit > 0) return explicit;
  const type = String(opts.returnType ?? opts.functionPrototype?.returnType ?? opts.prototype?.returnType ?? '').trim().toLowerCase();
  if (/^(?:u?int(?:8|16|32|64)(?:_t)?|char|signed char|unsigned char|short|unsigned short|int|unsigned int|long long|unsigned long long)$/.test(type)) {
    if (/8/.test(type) || /char/.test(type)) return 8;
    if (/16/.test(type) || /short/.test(type)) return 16;
    if (/64/.test(type) || /long long/.test(type)) return 64;
    return 32;
  }
  return null;
}

function detachUse(value, inst) {
  if (Array.isArray(value?.uses)) value.uses = value.uses.filter((use) => use !== inst);
}
function attachUse(value, inst) {
  if (!value) return;
  if (!Array.isArray(value.uses)) value.uses = [];
  if (!value.uses.includes(inst)) value.uses.push(inst);
}

/*
 * AArch64 W returns live in the low view of physical X0. Semantic v2 correctly
 * models that as a 32-bit value -> zext -> 64-bit X0 state assignment. For a
 * source-language 32-bit return, project the already-proven inner value back to
 * the decompiler instead of presenting the physical-storage-width wrapper.
 */
function exactNarrowReturnSource(value, bits) {
  if (!value || !Number.isSafeInteger(bits) || bits <= 0) return value;
  if (Number(value.bits) === bits) return value;
  let current = value;
  const stateWrite = current.def;
  if (stateWrite?.op === OP.MOV && stateWrite.extra?.stateWrite && stateWrite.args?.length === 1) {
    current = stateWrite.args[0]?.value ?? current;
  }
  const extension = current?.def;
  if (extension?.op === OP.MOV && extension.sub === 'zext' && extension.args?.length === 1) {
    const inner = extension.args[0]?.value ?? null;
    if (inner && Number(inner.bits) === bits && Number(current.bits) > bits) return inner;
  }
  return value;
}

function projectDeclaredReturnView(ir, opts) {
  const bits = declaredIntegerReturnBits(opts);
  if (!bits || !ir?.instructions) return ir;
  for (const ret of ir.instructions) {
    if (ret.op !== OP.RET || ret.args?.length !== 1) continue;
    const prior = ret.args[0]?.value ?? null;
    const projected = exactNarrowReturnSource(prior, bits);
    if (!projected || projected === prior) continue;
    detachUse(prior, ret);
    ret.args[0].value = projected;
    ret.args[0].bits = projected.bits || bits;
    attachUse(projected, ret);
    ret.extra = { ...(ret.extra ?? {}), sourceLanguageReturnBits: bits, exactReturnViewProjection: true };
  }
  return ir;
}

/**
 * Preserve function-level ABI/prototype evidence when the decompiler asks the
 * Semantic IR facade to build IR. The prior facade forwarded only rowOfAddress,
 * so v2 compatibility could not project an explicit return value at multi-block
 * O0 epilogues even though the caller had already supplied returnType.
 */
export function decompileSemantic(model, opts = {}) {
  const semanticOpts = canonicalRuntimeOptions(opts);
  const ir = projectDeclaredReturnView(
    semanticOpts.ir || irFor(model, irOptionsFromDecompilerOptions(semanticOpts)),
    semanticOpts,
  );
  return decompileSemanticCore(model, { ...semanticOpts, ir });
}
