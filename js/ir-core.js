/*
 * Semantic IR public-core compatibility facade.
 *
 * Semantic IR v2 compatibility is the Phase 3 production default after the
 * completed shadow differential. Legacy ARM64 remains an explicit oracle mode;
 * there is still no catch-and-fallback path between the engines.
 */
export * from './architecture/compat/ir-core-arm64-aapcs64-v1.js';

import {
  buildIR as buildLegacyIR,
  OP as LEGACY_OP,
  VK as LEGACY_VK,
  MK as LEGACY_MK,
  stackPointerProvenanceOf as legacyStackPointerProvenanceOf,
} from './architecture/compat/ir-core-arm64-aapcs64-v1.js';
import { buildCfg, EDGE } from './cfg.js';
import { stableDigest } from './core/identity/index.js';
import {
  SEMANTIC_V2_MIGRATION_MODES,
  buildSemanticV2CompatibilityPipeline,
} from './semantics/compat/index.js';
import { ARM64_ARCHITECTURE } from './targets/architecture/index.js';
import { AAPCS64_ABI, classifyAAPCS64Arguments } from './targets/abi/aapcs64.js';

export { classifyAAPCS64Arguments as classifyCallArguments };

let semanticMigrationMode = SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT;
let lastSemanticV2Instrumentation = null;

function normalizeMode(mode) {
  const value = mode ?? semanticMigrationMode;
  if (value === SEMANTIC_V2_MIGRATION_MODES.LEGACY || value === SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT) return value;
  throw new TypeError('semantic-migration-mode-unsupported');
}

/** Explicit process/session migration switch. Legacy-v1 remains available as the compatibility oracle. */
export function setSemanticMigrationMode(mode) {
  semanticMigrationMode = normalizeMode(mode);
  lastSemanticV2Instrumentation = null;
  return semanticMigrationMode;
}

export function getSemanticMigrationMode() { return semanticMigrationMode; }
export function getLastSemanticV2Instrumentation() { return lastSemanticV2Instrumentation; }

function asLegacyAddress(address) {
  if (address == null) return null;
  try { return typeof address === 'bigint' ? address : BigInt(address); }
  catch { return null; }
}

function rowResolver(model, opts) {
  if (typeof opts?.rowOfAddress === 'function') {
    return (address) => {
      const normalized = asLegacyAddress(address);
      return normalized == null ? null : opts.rowOfAddress(normalized);
    };
  }
  const rows = new Map();
  for (const instruction of model?.instructions ?? []) {
    if (instruction?.address != null && Number.isSafeInteger(instruction.row)) rows.set(instruction.address.toString(), instruction.row);
  }
  return (address) => address == null ? null : (rows.get(address.toString()) ?? null);
}

function edgeKind(edge) {
  if (edge.kind === EDGE.TAKEN) return 'conditional-true';
  if (edge.kind === EDGE.JUMP) return 'branch';
  if (edge.kind === EDGE.UNKNOWN) return 'unknown';
  return 'fallthrough';
}

function ephemeralBinaryId(model) {
  const identity = (model?.instructions ?? []).map((instruction) => ({
    address: instruction?.address ?? null,
    mnemonic: instruction?.mnemonic ?? null,
    operands: instruction?.operands ?? null,
  }));
  return `migration-model-${stableDigest(identity)}`;
}

function aapcs64FunctionReturnLocation(options = {}) {
  const proto = options.functionPrototype || options.prototype || null;
  const type = String(options.returnType || proto?.returnType || proto?.ret || proto?.result || '').toLowerCase();
  const cls = String(options.returnClass || proto?.returnClass || proto?.abiClass || proto?.resultClass || '').toLowerCase();
  if (options.returnsValue === false || proto?.returnsValue === false || proto?.void === true || type === 'void' || cls === 'void') return null;
  if (proto?.indirectResult === true || cls === 'indirect') return null;
  if (cls.includes('fp') || cls.includes('float') || cls.includes('vector') || /^(float|double|__fp16)/.test(type)) {
    return { reg:'v0', bits:Number(proto?.returnBits || proto?.bits || options.returnBits || 64) || 64 };
  }
  if (type || cls || options.returnsValue === true || proto?.returnsValue === true) {
    return { reg:'x0', bits:Number(proto?.returnBits || proto?.bits || options.returnBits || 64) || 64 };
  }
  return null;
}

function aapcs64CompatAbiAdapter(options) {
  return {
    classifyCall({ node }) {
      const control = node?.attributes?.machineControlEffect ?? null;
      const callSite = {
        callTarget: control?.target ?? null,
        callPrototype: node?.attributes?.callPrototype ?? null,
      };
      const classified = classifyAAPCS64Arguments(callSite, options);
      const returnValue = AAPCS64_ABI.classifyCallReturn(callSite, options);
      const callArguments = (classified.srcs ?? [])
        .filter((source) => source?.t === 'reg' && source.reg)
        .map((source) => ({ reg: String(source.reg), bits: Number(source.bits ?? 0) || null }));
      return {
        callArguments,
        stackArguments: classified.stackArguments ?? [],
        stackArgsUnknown: classified.stackArgsUnknown !== false,
        stackArgsMayContainPointers: classified.stackArgsMayContainPointers !== false,
        argumentEvidence: classified.evidence ?? 'aapcs64-plugin',
        clobbers: AAPCS64_ABI.callerSaved(),
        returnReg: returnValue?.reg ?? null,
        returnBits: returnValue?.bits ?? null,
        returnEvidence: returnValue == null ? null : 'aapcs64-plugin',
      };
    },
    classifyFunctionReturn() {
      const result = aapcs64FunctionReturnLocation(options);
      return result == null ? null : { ...result, evidence:'prototype-aapcs64' };
    },
  };
}

function aapcs64RegionRootDescriptorProvider(options = {}) {
  const explicit = options.rootDescriptorProvider ?? options.regionOptions?.rootDescriptorProvider ?? null;
  return (request) => {
    if (typeof explicit === 'function') {
      const supplied = explicit(request);
      if (supplied != null) return supplied;
    }
    const identity = request?.variable?.physicalIdentity;
    if (identity?.kind !== 'register') return null;
    const registerId = String(identity.registerId ?? '');
    if (registerId === 'sp') {
      return {
        kind: 'stack-like',
        addressSpace: request.expectedAddressSpace ?? 'memory',
        baseOffset: 0,
        linearOffsets: true,
        rootIdentity: {
          kind: 'abi-storage-root',
          abi: 'aapcs64',
          storageClass: 'function-local-stack',
          registerId,
        },
      };
    }
    const argument = /^x([0-7])$/.exec(registerId);
    if (!argument) return null;
    return {
      kind: 'rooted-object',
      addressSpace: request.expectedAddressSpace ?? 'memory',
      baseOffset: 0,
      linearOffsets: true,
      rootIdentity: {
        kind: 'abi-entry-argument-root',
        abi: 'aapcs64',
        storageClass: 'external-entry-memory',
        argumentIndex: Number(argument[1]),
        registerId,
      },
    };
  };
}

function valueDominatesLegacyInstruction(value, inst, projected) {
  if (!value || !inst) return false;
  if (value.kind === LEGACY_VK.ARG) return true;
  const definition = value.def;
  if (!definition || definition === inst) return false;
  if (definition.block === inst.block) return Number(definition.row) <= Number(inst.row);
  const dominators = projected.dominators?.[inst.block];
  return dominators instanceof Set && dominators.has(definition.block);
}

function legacyDefinitionRecency(value, inst, projected) {
  if (!value || value.kind === LEGACY_VK.ARG || !value.def) return { scope:0, depth:0, row:Number.NEGATIVE_INFINITY };
  const definition = value.def;
  if (definition.block === inst.block) {
    return { scope:2, depth:Number.MAX_SAFE_INTEGER, row:Number(definition.row ?? Number.NEGATIVE_INFINITY) };
  }
  const dominators = projected.dominators?.[inst.block];
  if (!(dominators instanceof Set) || !dominators.has(definition.block)) {
    return { scope:-1, depth:-1, row:Number.NEGATIVE_INFINITY };
  }
  const definitionDominators = projected.dominators?.[definition.block];
  return {
    scope:1,
    depth:definitionDominators instanceof Set ? definitionDominators.size : 0,
    row:Number(definition.row ?? Number.NEGATIVE_INFINITY),
  };
}

function detachLegacyArguments(inst) {
  for (const arg of inst.args ?? []) {
    const value = arg?.value;
    if (!Array.isArray(value?.uses)) continue;
    value.uses = value.uses.filter((use) => use !== inst);
  }
  inst.args = [];
}

function selectReachingRegisterValue(projected, inst, reg, bits = null, excluded = null) {
  const candidates = (projected.values ?? [])
    .filter((value) => value !== excluded && value.reg === reg && value.kind !== LEGACY_VK.UNDEF
      && valueDominatesLegacyInstruction(value, inst, projected))
    .sort((left, right) => {
      const leftRecency = legacyDefinitionRecency(left, inst, projected);
      const rightRecency = legacyDefinitionRecency(right, inst, projected);
      if (leftRecency.scope !== rightRecency.scope) return rightRecency.scope - leftRecency.scope;
      if (leftRecency.depth !== rightRecency.depth) return rightRecency.depth - leftRecency.depth;
      if (leftRecency.row !== rightRecency.row) return rightRecency.row - leftRecency.row;
      const leftWidth = Number(bits) > 0 && left.bits === Number(bits) ? 1 : 0;
      const rightWidth = Number(bits) > 0 && right.bits === Number(bits) ? 1 : 0;
      if (leftWidth !== rightWidth) return rightWidth - leftWidth;
      return (right.id ?? 0) - (left.id ?? 0);
    });
  return candidates[0] ?? null;
}

function replaceLegacyArg(inst, from, to) {
  if (!inst || !from || !to || from === to) return false;
  let changed = false;
  for (const arg of inst.args ?? []) {
    if (arg?.value !== from) continue;
    arg.value = to;
    arg.bits = to.bits || arg.bits;
    changed = true;
  }
  if (!changed) return false;
  if (Array.isArray(from.uses)) from.uses = from.uses.filter((use) => use !== inst);
  if (!Array.isArray(to.uses)) to.uses = [];
  if (!to.uses.includes(inst)) to.uses.push(inst);
  return true;
}

/*
 * Generic SSA is deliberately ABI-neutral and therefore treats an unknown call's
 * state category as a broad clobber. At this AAPCS64 facade we may recover only
 * a callee-preserved physical register state. Memory effects are not changed.
 */
function restoreAapcs64PreservedStateReads(projected) {
  const callerSaved = new Set(AAPCS64_ABI.callerSaved().map(String));
  for (const inst of projected.instructions ?? []) {
    if (inst.op !== LEGACY_OP.MOV || !inst.extra?.stateRead || inst.args?.length !== 1) continue;
    const identity = inst.extra.stateRead?.physicalIdentity;
    if (identity?.kind !== 'register') continue;
    const reg = String(identity.registerId ?? '');
    if (!reg || callerSaved.has(reg)) continue;
    const unknown = inst.args[0]?.value;
    const call = unknown?.def;
    if (unknown?.kind !== LEGACY_VK.UNDEF || call?.op !== LEGACY_OP.CALL) continue;
    const reaching = selectReachingRegisterValue(projected, call, reg, inst.dst?.bits ?? unknown.bits, unknown);
    if (!reaching) continue;
    replaceLegacyArg(inst, unknown, reaching);
    inst.extra.abiPreservedState = true;
    inst.extra.abiPreservedStateEvidence = 'aapcs64-callee-preserved';
  }
}

function exactLegacyConstant(value, active = new Set()) {
  if (!value || active.has(value.id)) return null;
  if (value.const != null) {
    try { return BigInt(value.const); } catch { return null; }
  }
  const def = value.def;
  if (!def) return null;
  active.add(value.id);
  let result = null;
  if (def.op === LEGACY_OP.CONST || def.op === LEGACY_OP.ADDR) {
    try { result = BigInt(def.extra?.value ?? def.extra?.target); } catch { result = null; }
  } else if (def.op === LEGACY_OP.MOV && def.args?.length === 1) {
    const inner = exactLegacyConstant(def.args[0]?.value, active);
    if (inner != null) {
      if (def.sub === 'trunc' || def.sub === 'zext') result = BigInt.asUintN(Number(value.bits || 64), inner);
      else if (def.sub == null || def.sub === 'copy' || def.sub === 'bitcast') result = inner;
    }
  } else if (def.op === LEGACY_OP.BIN && def.args?.length >= 2) {
    const left = exactLegacyConstant(def.args[0]?.value, active);
    const right = exactLegacyConstant(def.args[1]?.value, active);
    if (left != null && right != null) {
      const bits = Number(value.bits || 64);
      if (def.sub === 'add') result = left + right;
      else if (def.sub === 'sub') result = left - right;
      else if (def.sub === 'mul') result = left * right;
      else if (def.sub === 'and') result = left & right;
      else if (def.sub === 'or') result = left | right;
      else if (def.sub === 'xor') result = left ^ right;
      else if (def.sub === 'shl') result = left << right;
      else if (def.sub === 'lshr') result = BigInt.asUintN(bits, left) >> right;
      if (result != null) result = BigInt.asUintN(bits, result);
    }
  }
  active.delete(value.id);
  return result;
}

function propagateExactLegacyConstants(projected) {
  for (const value of projected.values ?? []) {
    if (value.const != null) continue;
    const constant = exactLegacyConstant(value);
    if (constant != null) value.const = BigInt.asUintN(Number(value.bits || 64), constant);
  }
}

function canonicalAddressBase(value, active = new Set()) {
  if (!value || active.has(value.id)) return value;
  active.add(value.id);
  const def = value.def;
  if (def?.op === LEGACY_OP.MOV && def.args?.length === 1
      && (def.extra?.stateRead || def.extra?.stateWrite || def.sub == null)) {
    const inner = canonicalAddressBase(def.args[0]?.value, active);
    active.delete(value.id);
    return inner || value;
  }
  active.delete(value.id);
  return value;
}

/*
 * MemorySSA alias conclusions remain authoritative. This restores only the
 * legacy public location shape from already-proven precise address metadata.
 */
function restoreAapcs64PublicLocations(projected) {
  for (const inst of projected.instructions ?? []) {
    if (inst.op !== LEGACY_OP.LOAD && inst.op !== LEGACY_OP.STORE) continue;
    if ((inst.loc?.kind !== LEGACY_MK.UNKNOWN && inst.loc?.kind !== LEGACY_MK.STACK) || inst.addr?.precise !== true || inst.addr.index != null) continue;
    const stack = legacyStackPointerProvenanceOf(inst.addr.base);
    if (stack?.must === true) {
      const offset = BigInt(stack.offset ?? 0n) + BigInt(inst.addr.disp ?? 0n);
      const size = inst.addr.size ?? inst.extra?.size ?? null;
      const existing = inst.loc?.kind === LEGACY_MK.STACK && inst.loc.disp != null && BigInt(inst.loc.disp) === offset
        && (inst.loc.size == null || size == null || Number(inst.loc.size) === Number(size)) ? inst.loc : null;
      const key = existing?.key ?? `stack:${offset.toString()}`;
      const loc = existing ?? {
        key,
        kind: LEGACY_MK.STACK,
        disp: offset,
        size,
        regionId: inst.loc?.regionId ?? null,
        origin: inst.loc?.origin ?? inst.addr?.origin ?? null,
        compatAbiPreservedAddress: true,
      };
      if (!existing) projected.locations?.set?.(key, loc);
      inst.loc = loc;
      inst.extra = { ...(inst.extra ?? {}), compatAbiPreservedAddress: true };
      continue;
    }
    const base = canonicalAddressBase(inst.addr.base);
    if (base?.def?.op !== LEGACY_OP.LOAD || !base.def.reachingStore) continue;
    const disp = BigInt(inst.addr.disp ?? 0n);
    const size = inst.addr.size ?? inst.extra?.size ?? null;
    const key = `field:loaded:${base.id}+${disp.toString()}:s${size ?? '?'}`;
    const loc = {
      key,
      kind: LEGACY_MK.FIELD,
      base,
      disp,
      size,
      regionId: inst.loc?.regionId ?? null,
      origin: inst.loc?.origin ?? inst.addr?.origin ?? null,
      aliasUncertain: true,
      compatibilityShapeOnly: true,
    };
    projected.locations?.set?.(key, loc);
    inst.loc = loc;
    inst.extra = { ...(inst.extra ?? {}), compatibilityShapeOnly: true };
  }
}

function attachAapcs64CallArguments(projected) {
  for (const inst of projected.instructions ?? []) {
    if (inst.op !== LEGACY_OP.CALL || !Array.isArray(inst.callArguments)) continue;
    detachLegacyArguments(inst);
    const seen = new Set();
    for (const descriptor of inst.callArguments) {
      const reg = descriptor?.reg == null ? null : String(descriptor.reg);
      if (!reg) continue;
      const value = selectReachingRegisterValue(projected, inst, reg, descriptor.bits ?? null);
      if (!value || seen.has(value.id)) continue;
      seen.add(value.id);
      inst.args.push({ value, bits:value.bits || descriptor.bits || 64 });
      if (!Array.isArray(value.uses)) value.uses = [];
      if (!value.uses.includes(inst)) value.uses.push(inst);
    }
    inst.extra = {
      ...(inst.extra ?? {}),
      abiProjectedArgumentValueIds: inst.args.map((arg) => arg.value?.semanticSsaValueId ?? arg.value?.semanticValueId ?? arg.value?.id),
    };
  }
}

function attachAapcs64TypedCallResults(projected, instructionByRow, options = {}) {
  for (const inst of projected.instructions ?? []) {
    if (inst.op !== LEGACY_OP.CALL || inst.dst) continue;
    const decoded = instructionByRow.get(inst.row) ?? null;
    const result = decoded == null ? null : AAPCS64_ABI.classifyCallReturn(decoded, options);
    if (!result?.reg) continue;
    const reg = String(result.reg);
    const bits = Number(result.bits || 64);
    const candidates = (projected.values ?? [])
      .filter((value) => value?.reg === reg
        && value?.sourceEntityId === inst.semanticNodeId
        && value?.def == null)
      .sort((left, right) => Number(right.id ?? -1) - Number(left.id ?? -1));
    const priorVersion = Math.max(-1, ...(projected.values ?? [])
      .filter((value) => value?.reg === reg)
      .map((value) => Number(value.version ?? -1)));
    const value = candidates[0] ?? {
      id: (projected.values ?? []).length,
      vid: (projected.values ?? []).length + 1,
      kind: LEGACY_VK.DEF,
      reg,
      stateKey: null,
      version: priorVersion + 1,
      bits,
      def: null,
      uses: [],
      const: null,
      range: null,
      signed: null,
      nullable: null,
      type: null,
      label: reg,
      semanticValueId: null,
      semanticSsaValueId: null,
      sourceEntityId: inst.semanticNodeId,
      machineType: null,
      origin: inst.origin ?? null,
      compatibilityShapeOnly: true,
    };
    if (!candidates[0]) projected.values.push(value);
    value.kind = LEGACY_VK.DEF;
    value.reg = reg;
    value.bits = bits;
    value.def = inst;
    value.unknown = true;
    delete value.undefined;
    delete value.clobbered;
    value.compatDerived = 'typed-abi-call-result';
    inst.dst = value;
    inst.returnReg = reg;
    inst.returnBits = bits;
    inst.returnEvidence = 'prototype-aapcs64-call';
    inst.extra = {
      ...(inst.extra ?? {}),
      compatTypedCallResult: true,
      compatTypedCallResultEvidence: inst.returnEvidence,
    };
  }
}

function valueMayCarryStackAddress(value) {
  const proof = legacyStackPointerProvenanceOf(value);
  return proof?.must === true || proof?.may === true;
}

function storeMayEscapeStackAddress(inst) {
  return inst?.op === LEGACY_OP.STORE && valueMayCarryStackAddress(inst.args?.[0]?.value);
}

/*
 * Keep canonical MemorySSA conservative across unknown calls. For the legacy-v1
 * compatibility shape only, reconnect one same-block stack load to its previous
 * stack store when the address of caller-local stack storage is proven not to
 * escape across any intervening call/barrier. The canonical memUse remains the
 * call-clobber node, so this cannot turn MemorySSA's unknown into NoAlias.
 */

function invalidateEscapedStackForwarding(projected) {
  for (const load of projected.instructions ?? []) {
    if (load.op !== LEGACY_OP.LOAD || load.loc?.kind !== LEGACY_MK.STACK || !load.reachingStore) continue;
    const store = load.reachingStore;
    const block = projected.blocks?.[load.block];
    if (!block || store.block !== load.block) continue;
    for (const inst of block.insts ?? []) {
      if (Number(inst.row) <= Number(store.row) || Number(inst.row) >= Number(load.row)) continue;
      if (inst.op !== LEGACY_OP.CALL) continue;
      if (!(inst.args ?? []).some((arg) => valueMayCarryStackAddress(arg?.value))) continue;
      const priorMemoryUse = load.memUse ?? null;
      load.reachingStore = undefined;
      load.memUse = {
        kind:'clobber',
        definitionId:null,
        regionId:priorMemoryUse?.regionId ?? load.loc?.regionId ?? null,
        clobberingInstructionId:inst.id,
        previousDefinitionId:priorMemoryUse?.definitionId ?? null,
        compatibilityDerived:true,
        evidence:'aapcs64-stack-argument-escape',
      };
      load.extra = {
        ...(load.extra ?? {}),
        compatStackEscapeInvalidation:true,
        compatStackEscapeCallInstructionId:inst.id,
        canonicalMemoryUseKind:priorMemoryUse?.kind ?? null,
        canonicalMemoryDefinitionId:priorMemoryUse?.definitionId ?? null,
      };
      break;
    }
  }
}

function restoreProvenNoEscapeStackForwarding(projected) {
  for (const load of projected.instructions ?? []) {
    if (load.op !== LEGACY_OP.LOAD || load.loc?.kind !== LEGACY_MK.STACK || load.reachingStore) continue;
    const block = projected.blocks?.[load.block];
    if (!block) continue;
    const priorStores = (block.insts ?? [])
      .filter((inst) => {
        if (inst.op !== LEGACY_OP.STORE || inst.loc?.kind !== LEGACY_MK.STACK || inst.loc.key !== load.loc.key || Number(inst.row) >= Number(load.row)) return false;
        const loadSize = Number(load.loc?.size ?? load.extra?.size ?? 0);
        const storeSize = Number(inst.loc?.size ?? inst.extra?.size ?? 0);
        if (!(loadSize > 0 && storeSize > 0 && loadSize === storeSize)) return false;
        if (load.extra?.signed === true || load.extra?.extension === 'sign') return false;
        const loadBits = Number(load.dst?.bits ?? loadSize * 8);
        const storeBits = Number(inst.args?.[0]?.bits ?? inst.args?.[0]?.value?.bits ?? storeSize * 8);
        return loadBits === storeBits;
      })
      .sort((left, right) => Number(right.row) - Number(left.row));
    const store = priorStores[0] ?? null;
    if (!store) continue;
    let blocked = false;
    const evidence = [];
    for (const inst of block.insts ?? []) {
      if (Number(inst.row) <= Number(store.row) || Number(inst.row) >= Number(load.row)) continue;
      if (inst.op === LEGACY_OP.UNKNOWN) { blocked = true; break; }
      if (inst.op === LEGACY_OP.STORE) {
        if (inst.loc?.key === load.loc.key || storeMayEscapeStackAddress(inst)) { blocked = true; break; }
        continue;
      }
      if (inst.op !== LEGACY_OP.CALL) continue;
      if ((inst.args ?? []).some((arg) => valueMayCarryStackAddress(arg?.value))) { blocked = true; break; }
      evidence.push({ callInstructionId:inst.id, row:inst.row, proof:'no-stack-derived-call-argument' });
    }
    if (blocked) continue;
    load.reachingStore = store;
    load.extra = {
      ...(load.extra ?? {}),
      compatNoEscapeStackForwarding: true,
      compatNoEscapeStackEvidence: evidence,
      canonicalMemoryUsePreserved: load.memUse?.definitionId ?? null,
    };
  }
}

/**
 * Semantic IR return nodes carry the architectural control target (for A64 RET,
 * typically the link register). That is not a source-language return value.
 */
function attachAapcs64FunctionReturns(projected, adapter) {
  const result = adapter?.classifyFunctionReturn?.() ?? null;
  for (const inst of projected?.instructions ?? []) {
    if (inst.op !== LEGACY_OP.RET) continue;
    detachLegacyArguments(inst);
    inst.returnReg = null;
    inst.returnEvidence = null;
    if (!result?.reg) continue;
    const value = selectReachingRegisterValue(projected, inst, result.reg, result.bits ?? null);
    if (!value) continue;
    inst.args = [{ value, bits:value.bits || result.bits || 64 }];
    if (!Array.isArray(value.uses)) value.uses = [];
    if (!value.uses.includes(inst)) value.uses.push(inst);
    inst.returnReg = result.reg;
    inst.returnEvidence = result.evidence ?? 'aapcs64-plugin';
    inst.extra = {
      ...(inst.extra ?? {}),
      abiProjectedReturnValueId: value.semanticSsaValueId ?? value.semanticValueId ?? value.id,
      abiProjectedReturnEvidence: inst.returnEvidence,
    };
  }
}

function buildV2CompatFromLegacyModel(model, opts = {}) {
  if (!model?.instructions?.length) return null;
  const rowOfAddress = rowResolver(model, opts);
  const legacyCfg = opts.cfg ?? buildCfg(model, { rowOfAddress });
  const instructionByRow = new Map(model.instructions.map((instruction) => [instruction.row, instruction]));
  const blocks = legacyCfg.nodes.map((node) => {
    const instructions = [];
    for (let row = node.startRow; row <= node.endRow; row++) {
      const instruction = instructionByRow.get(row);
      if (!instruction || instruction.data) continue;
      instructions.push({
        decoded: instruction,
        address: instruction.address,
        size: 4,
        mode: 'a64',
      });
    }
    const first = instructions[0]?.decoded?.address;
    if (first == null) throw new TypeError('semantic-v2-compat-empty-basic-block');
    return {
      key: `legacy-block-${node.index}`,
      startAddress: first,
      instructions,
      successors: node.succ
        .filter((successor) => successor.to >= 0)
        .map((successor) => ({ to: `legacy-block-${successor.to}`, kind: edgeKind(successor) })),
    };
  });
  const binaryId = String(opts.binaryId ?? model.binaryId ?? ephemeralBinaryId(model));
  const sliceId = String(opts.sliceId ?? model.sliceId ?? `migration-slice-${stableDigest({ binaryId, architecture: 'arm64' })}`);
  const abiAdapter = opts.abiAdapter ?? aapcs64CompatAbiAdapter(opts);
  const result = buildSemanticV2CompatibilityPipeline({
    architecturePlugin: ARM64_ARCHITECTURE,
    decoderSemanticVersion: String(opts.decoderSemanticVersion ?? 'legacy-model-decoder-v1'),
    binaryId,
    sliceId,
    addressWidthBits: 64,
    canonicalStartIdentity: { address: model.startAddress ?? model.instructions[0].address },
    entryBlockKey: legacyCfg.entry >= 0 ? `legacy-block-${legacyCfg.entry}` : blocks[0]?.key,
    blocks,
    abiAdapter,
    rootDescriptorProvider: aapcs64RegionRootDescriptorProvider(opts),
  }, {
    signal: opts.signal,
    semanticIrOptions: opts.semanticIrOptions,
    ssaOptions: opts.ssaOptions,
    memorySsaOptions: opts.memorySsaOptions,
    compatOptions: {
      rowOfNode(node) {
        const address = node?.origin?.virtualRanges?.[0]?.start;
        return address == null ? null : rowOfAddress(address);
      },
      textOfNode(node) {
        const address = node?.origin?.virtualRanges?.[0]?.start;
        const row = address == null ? null : rowOfAddress(address);
        const instruction = row == null ? null : instructionByRow.get(row);
        return instruction ? `${instruction.mnemonic} ${instruction.operands ?? ''}`.trim() : `semantic-v2 ${node.kind}`;
      },
      ...(opts.compatOptions ?? {}),
    },
  });
  restoreAapcs64PreservedStateReads(result.legacyV1);
  restoreAapcs64PublicLocations(result.legacyV1);
  propagateExactLegacyConstants(result.legacyV1);
  attachAapcs64CallArguments(result.legacyV1);
  attachAapcs64TypedCallResults(result.legacyV1, instructionByRow, opts);
  invalidateEscapedStackForwarding(result.legacyV1);
  restoreProvenNoEscapeStackForwarding(result.legacyV1);
  attachAapcs64FunctionReturns(result.legacyV1, abiAdapter);
  lastSemanticV2Instrumentation = result.instrumentation;
  return result.legacyV1;
}

/**
 * Explicit semantic-engine dispatch. No v2 exception is caught and rerouted to
 * legacy; semantic-v2-compat either returns its compatibility projection or
 * fails/returns explicit unknowns from the v2 pipeline.
 */
export function buildIR(model, opts = {}) {
  const mode = normalizeMode(opts.semanticMigrationMode);
  if (mode === SEMANTIC_V2_MIGRATION_MODES.LEGACY) return buildLegacyIR(model, opts);
  lastSemanticV2Instrumentation = null;
  return buildV2CompatFromLegacyModel(model, opts);
}
