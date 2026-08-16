export * from './semantic-core.js';

import { irFor, getSemanticMigrationMode, OP, MK } from '../ir.js';
import {
  decompileSemantic as decompileSemanticCore,
  recoverInductionVariables as recoverInductionVariablesCore,
} from './semantic-core.js';

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
function replaceArgValue(inst, index, value) {
  const prior = inst?.args?.[index]?.value ?? null;
  if (!inst?.args?.[index] || !value || prior === value) return false;
  detachUse(prior, inst);
  inst.args[index].value = value;
  inst.args[index].bits = value.bits || inst.args[index].bits;
  attachUse(value, inst);
  return true;
}

const EXACT_VIEW_MOV_SUBS = new Set([null, 'copy', 'bitcast', 'trunc', 'zext']);

/*
 * Return an architecture-neutral proof trace through v1 MOV nodes that are
 * already marked as exact state/cast projections. Identity state moves are not
 * semantic transforms; trunc/zext steps are retained so two equal-width views
 * are considered identical only when their cast histories are identical.
 */
function exactViewTrace(value, active = new Set()) {
  if (!value || active.has(value.id)) return null;
  active.add(value.id);
  let current = value;
  const steps = [];
  while (current?.def?.op === OP.MOV && current.def.args?.length === 1) {
    const def = current.def;
    const sub = def.sub ?? null;
    const exactIdentity = sub == null || sub === 'copy' || sub === 'bitcast'
      || def.extra?.stateRead || def.extra?.stateWrite;
    if (!exactIdentity && !EXACT_VIEW_MOV_SUBS.has(sub)) break;
    const source = def.args[0]?.value ?? null;
    if (!source || active.has(source.id)) break;
    if (sub === 'trunc' || sub === 'zext') {
      steps.push(`${sub}:${Number(source.bits || 0)}>${Number(current.bits || 0)}`);
    }
    active.add(source.id);
    current = source;
  }
  return { root: current, bits: Number(value.bits || 0), steps };
}

function sameExactView(left, right) {
  if (!left || !right || Number(left.bits || 0) !== Number(right.bits || 0)) return false;
  const a = exactViewTrace(left), b = exactViewTrace(right);
  if (!a?.root || !b?.root || a.root.id !== b.root.id || a.steps.length !== b.steps.length) return false;
  return a.steps.every((step, index) => step === b.steps[index]);
}

/* A stored narrow view may be the exact projection of an incoming wider state. */
function storedViewProjectsIncoming(stored, incoming, store) {
  if (!stored || !incoming || !store) return false;
  if (stored === incoming) return true;
  const a = exactViewTrace(stored), b = exactViewTrace(incoming);
  if (!a?.root || !b?.root || a.root.id !== b.root.id) return false;
  const widthBits = Number((store.loc?.size ?? store.addr?.size ?? store.extra?.size ?? 0) * 8);
  if (widthBits > 0 && Number(stored.bits || 0) !== widthBits) return false;
  if (a.steps.length < b.steps.length) return false;
  const suffix = a.steps.slice(a.steps.length - b.steps.length);
  return suffix.every((step, index) => step === b.steps[index]);
}

function canonicalLocationBase(value, active = new Set()) {
  if (!value || active.has(value.id)) return value;
  active.add(value.id);
  const trace = exactViewTrace(value);
  let root = trace?.root ?? value;
  const def = root?.def;
  if (def?.op === OP.LOAD && def.reachingStore?.args?.[0]?.value) {
    root = canonicalLocationBase(def.reachingStore.args[0].value, active) ?? root;
  } else if (def?.op === OP.PHI && Array.isArray(def.incoming) && def.incoming.length) {
    const roots = def.incoming.map((item) => canonicalLocationBase(item.value, new Set(active))).filter(Boolean);
    const first = roots[0] ?? null;
    if (first && roots.every((candidate) => candidate.id === first.id)) root = first;
  }
  active.delete(value.id);
  return root;
}

function sameLocationBase(left, right) {
  const a = canonicalLocationBase(left), b = canonicalLocationBase(right);
  if (!a || !b) return false;
  if (a.id === b.id) return true;
  return a.kind === 'arg' && b.kind === 'arg' && a.reg && a.reg === b.reg;
}

function sameCommittedFieldLocation(left, right) {
  if (!left || !right || left.kind !== MK.FIELD || right.kind !== MK.FIELD) return false;
  try {
    if (BigInt(left.disp ?? 0) !== BigInt(right.disp ?? 0)) return false;
  } catch { return false; }
  const leftSize = Number(left.size ?? 0), rightSize = Number(right.size ?? 0);
  if (leftSize > 0 && rightSize > 0 && leftSize !== rightSize) return false;
  return sameLocationBase(left.base, right.base);
}

function hasBarrierAfterStore(block, store) {
  return (block?.insts || []).some((inst) => Number(inst.row) > Number(store.row)
    && (inst.op === OP.CALL || inst.op === OP.UNKNOWN || inst.op === OP.STORE));
}

function committedStoreForIncoming(ir, incoming) {
  const block = ir?.blocks?.[incoming?.from];
  if (!block || !incoming?.value) return null;
  const stores = (block.insts || [])
    .filter((inst) => inst.op === OP.STORE && inst.loc?.kind === MK.FIELD
      && storedViewProjectsIncoming(inst.args?.[0]?.value, incoming.value, inst))
    .sort((left, right) => Number(right.row) - Number(left.row));
  for (const store of stores) {
    if (!hasBarrierAfterStore(block, store)) return store;
  }
  return null;
}

/*
 * A scalar PHI may represent the value already committed to one logical field on
 * every predecessor. Replace only the decompiler-facing PHI operation with a
 * snapshot LOAD when every incoming edge proves such a store, all stores target
 * the same field, and no later store/call/unknown exists before the edge.
 * Canonical SSA and MemorySSA contracts are not modified.
 */
function projectCommittedPhiSnapshots(ir) {
  for (const phi of ir?.instructions || []) {
    if (phi.op !== OP.PHI || !Array.isArray(phi.incoming) || phi.incoming.length < 2 || !phi.dst) continue;
    const stores = phi.incoming.map((incoming) => committedStoreForIncoming(ir, incoming));
    if (stores.some((store) => !store)) continue;
    const first = stores[0];
    if (!stores.every((store) => sameCommittedFieldLocation(first.loc, store.loc))) continue;
    const viewBits = Number((first.loc?.size ?? first.addr?.size ?? first.extra?.size ?? 0) * 8)
      || Number(first.args?.[0]?.value?.bits ?? 0) || null;
    phi.extra = {
      ...(phi.extra ?? {}),
      compatOriginalOp: OP.PHI,
      committedPhiSnapshot: true,
      committedStoreRows: stores.map((store) => store.row),
      committedLocationKey: first.loc.key,
      committedViewBits: viewBits,
    };
    phi.op = OP.LOAD;
    phi.sub = null;
    phi.loc = first.loc;
    phi.addr = first.addr ?? null;
    phi.reachingStore = null;
    phi.memUse = null;
  }
  return ir;
}

/*
 * Once a committed PHI snapshot is proven to represent a narrower memory field,
 * an exact truncation of that snapshot to the field width is not a source-level
 * cast. Re-express only that exact view as a decompiler-facing LOAD with the
 * existing 32/16/8-bit destination. The physical-state SSA remains unchanged.
 */
function projectCommittedSnapshotViews(ir) {
  for (const inst of ir?.instructions || []) {
    if (inst.op !== OP.MOV || inst.sub !== 'trunc' || !inst.dst || inst.args?.length !== 1) continue;
    const source = inst.args[0]?.value ?? null;
    const trace = exactViewTrace(source);
    const snapshot = trace?.root?.def;
    const viewBits = Number(snapshot?.extra?.committedViewBits ?? 0);
    if (snapshot?.op !== OP.LOAD || snapshot.extra?.committedPhiSnapshot !== true
        || viewBits <= 0 || Number(inst.dst.bits || 0) !== viewBits) continue;
    detachUse(source, inst);
    inst.op = OP.LOAD;
    inst.sub = null;
    inst.args = [];
    inst.loc = snapshot.loc;
    inst.addr = snapshot.addr ?? null;
    inst.reachingStore = null;
    inst.memUse = null;
    inst.extra = {
      ...(inst.extra ?? {}),
      compatOriginalOp: OP.MOV,
      compatOriginalSub: 'trunc',
      committedSnapshotView: true,
      committedViewBits: viewBits,
    };
  }
  return ir;
}

/*
 * If a comparison consumes another exact view of the value just committed by a
 * same-block store, use that stored value object for this comparison only. This
 * preserves the legacy "compare committed lvalue" behavior without globally
 * collapsing register/cast provenance (which would break threshold evidence).
 */
function projectCommittedComparisonViews(ir) {
  for (const cmp of ir?.instructions || []) {
    if (cmp.op !== OP.CMP || cmp.row == null) continue;
    const block = ir.blocks?.[cmp.block];
    if (!block) continue;
    for (let index = 0; index < (cmp.args?.length ?? 0); index++) {
      const value = cmp.args[index]?.value;
      if (!value) continue;
      const stores = (block.insts || [])
        .filter((store) => store.op === OP.STORE && store.loc?.kind !== MK.UNKNOWN
          && store.row != null && Number(store.row) < Number(cmp.row)
          && sameExactView(store.args?.[0]?.value, value))
        .sort((left, right) => Number(right.row) - Number(left.row));
      const store = stores[0] ?? null;
      if (!store) continue;
      const blocked = (block.insts || []).some((candidate) => Number(candidate.row) > Number(store.row) && Number(candidate.row) < Number(cmp.row)
        && (candidate.op === OP.STORE || candidate.op === OP.CALL || candidate.op === OP.UNKNOWN));
      if (blocked) continue;
      replaceArgValue(cmp, index, store.args[0].value);
      cmp.extra = { ...(cmp.extra ?? {}), committedComparisonView: true, committedStoreRow: store.row };
    }
  }
  return ir;
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
    replaceArgValue(ret, 0, projected);
    ret.extra = { ...(ret.extra ?? {}), sourceLanguageReturnBits: bits, exactReturnViewProjection: true };
  }
  return ir;
}

function compatBlockTerm(block) {
  const insts = block?.insts || [];
  for (let index = insts.length - 1; index >= 0; index--) {
    if ([OP.CBR, OP.BR, OP.RET].includes(insts[index].op)) return insts[index];
  }
  return null;
}

function compatInductionRoot(value) {
  return exactViewTrace(value)?.root ?? value ?? null;
}

/*
 * Semantic-v2 compatibility keeps physical-state width changes explicit, so a
 * loop-carried scalar may reach its PHI through exact MOV/trunc/zext projections.
 * Recover only that already-proven recurrence shape after the legacy detector
 * declines it; no opcode text or architecture-specific register knowledge is used.
 */
function recoverCompatInductionVariables(ir, ctx = null) {
  const out = [];
  for (const loop of ir?.loops || []) {
    const block = ir.blocks?.[loop.header];
    for (const phi of block?.phis || []) {
      if (!phi.dst || (phi.incoming || []).length !== 2) continue;
      const outside = phi.incoming.find((edge) => !loop.nodes.has(edge.from));
      const inside = phi.incoming.find((edge) => loop.nodes.has(edge.from));
      if (!outside || !inside) continue;
      const updateValue = compatInductionRoot(inside.value);
      const stepDef = updateValue?.def;
      if (!stepDef || stepDef.op !== OP.BIN || !['add', 'sub'].includes(stepDef.sub)) continue;
      const left = stepDef.args?.[0]?.value ?? null;
      const right = stepDef.args?.[1]?.value ?? null;
      const leftRoot = compatInductionRoot(left);
      const rightRoot = compatInductionRoot(right);
      let step = null;
      if (leftRoot?.id === phi.dst.id && right?.const != null) {
        step = stepDef.sub === 'add' ? right.const : -right.const;
      } else if (stepDef.sub === 'add' && rightRoot?.id === phi.dst.id && left?.const != null) {
        step = left.const;
      }
      if (step == null) continue;
      const term = compatBlockTerm(block);
      if (!term || term.op !== OP.CBR) continue;
      const name = `i${out.length || ''}`;
      out.push({
        loop,
        phi,
        value: phi.dst,
        name,
        init: outside.value,
        step,
        conditionInst: term,
        initText: null,
        conditionText: null,
        compatExactView: true,
        ...(ctx ? { contextAvailable: true } : {}),
      });
    }
  }
  return out;
}

export function recoverInductionVariables(ir, ctx = null) {
  const direct = recoverInductionVariablesCore(ir, ctx);
  if (direct.length || ir?.compat?.projection !== 'semantic-ir-v2-to-v1') return direct;
  return recoverCompatInductionVariables(ir, ctx);
}

/**
 * Preserve the historical legacy decompiler construction exactly. Full ABI /
 * prototype context and the committed-snapshot compatibility projections are
 * enabled only for the explicit semantic-v2-to-v1 route.
 */
export function decompileSemantic(model, opts = {}) {
  const semanticOpts = canonicalRuntimeOptions(opts);
  const v2Requested = getSemanticMigrationMode() === 'semantic-v2-compat';
  let ir = semanticOpts.ir || irFor(model, v2Requested
    ? irOptionsFromDecompilerOptions(semanticOpts)
    : { rowOfAddress: semanticOpts.rowOfAddress });
  const isV2Compat = ir?.compat?.projection === 'semantic-ir-v2-to-v1';
  if (isV2Compat) {
    ir = projectCommittedComparisonViews(ir);
    ir = projectCommittedPhiSnapshots(ir);
    ir = projectCommittedSnapshotViews(ir);
    ir = projectDeclaredReturnView(ir, semanticOpts);
  }
  return decompileSemanticCore(model, { ...semanticOpts, ir });
}