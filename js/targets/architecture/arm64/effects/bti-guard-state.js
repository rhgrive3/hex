import {
  createBitVectorValue,
  createIntrinsicEffectSummary,
  createMachineEffectBundle,
  createMachineOperation,
  createRegisterValue,
  createTemporaryValue,
} from '../../../../semantics/effects/index.js';

export const ARM64_BTI_PAGE_GUARD_STATE_ID = 'arm64.exec-page.guarded';

function mnemonicOf(instruction) {
  return String(instruction?.mnemonic || '').trim().toLowerCase();
}

function deepCopyEvidence(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(deepCopyEvidence);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepCopyEvidence(item)]));
  return value;
}

export function normalizeArm64BtiGuardedPageState(input = null) {
  if (typeof input === 'boolean') {
    return Object.freeze({
      state:input ? 'guarded' : 'unguarded',
      mappedPageGuarded:input,
      source:'explicit-execution-context',
      evidence:null,
      loaderPolicy:null,
    });
  }
  if (!input || typeof input !== 'object') {
    return Object.freeze({
      state:'unknown', mappedPageGuarded:null, source:'not-observed', evidence:null, loaderPolicy:null,
    });
  }
  const raw = input.mappedPageGuarded ?? input.guarded ?? input.state;
  let state = 'unknown';
  let mappedPageGuarded = null;
  if (raw === true || raw === 'guarded') { state = 'guarded'; mappedPageGuarded = true; }
  else if (raw === false || raw === 'unguarded') { state = 'unguarded'; mappedPageGuarded = false; }
  return Object.freeze({
    state,
    mappedPageGuarded,
    source:String(input.source || input.mappedPageGuardedSource || 'execution-context'),
    evidence:deepCopyEvidence(input.evidence ?? input.mappingEvidence ?? null),
    loaderPolicy:deepCopyEvidence(input.loaderPolicy ?? input.elfPolicy ?? null),
  });
}

export function arm64BtiGuardedPageStateFromImage(image, address, runtime = {}) {
  const loaderPolicy = image?.metadata?.arm64Bti ?? null;
  const actual = runtime.mappedPageGuarded ?? runtime.guardedPage ?? null;
  if (typeof actual === 'boolean') {
    return normalizeArm64BtiGuardedPageState({
      mappedPageGuarded:actual,
      source:runtime.source || 'runtime-mapping',
      mappingEvidence:{
        address:address == null ? null : String(address),
        ...(runtime.evidence == null ? {} : { runtime:runtime.evidence }),
      },
      loaderPolicy,
    });
  }
  return normalizeArm64BtiGuardedPageState({
    state:'unknown',
    source:'loader-policy-is-not-runtime-page-state',
    mappingEvidence:{ address:address == null ? null : String(address) },
    loaderPolicy,
  });
}

function landingKindOf(instruction) {
  const operands = Array.isArray(instruction?.ops)
    ? instruction.ops
    : Array.isArray(instruction?.parsed)
      ? instruction.parsed
      : Array.isArray(instruction?.operandsParsed)
        ? instruction.operandsParsed
        : [];
  const raw = String(operands[0]?.text || instruction?.operands || '').trim().toLowerCase();
  if (!raw) return Object.freeze({ kind:'encoded', code:0 });
  const normalized = raw.replace(/^bti\s+/, '').trim();
  if (normalized === 'c') return Object.freeze({ kind:'c', code:1 });
  if (normalized === 'j') return Object.freeze({ kind:'j', code:2 });
  if (normalized === 'jc') return Object.freeze({ kind:'jc', code:3 });
  return null;
}

function rebuildIntrinsic(operation, guardValue, landing) {
  const summary = operation.effectSummary;
  return createMachineOperation({
    kind:'intrinsic',
    ...(operation.id == null ? {} : { id:operation.id }),
    intrinsicId:operation.intrinsicId,
    effectSummary:createIntrinsicEffectSummary({
      inputs:[guardValue, ...summary.inputs, createBitVectorValue(2, landing.code)],
      outputs:summary.outputs,
      registersRead:summary.registersRead,
      registersWritten:summary.registersWritten,
      memoryRead:summary.memoryRead,
      memoryWrite:summary.memoryWrite,
      controlEffects:summary.controlEffects,
      determinism:summary.determinism,
      symbolicDetail:summary.symbolicDetail,
    }),
    metadata:{
      ...(operation.metadata || {}),
      landingPadKind:landing.kind,
      guardedPageInput:true,
      inputOrder:['page-guarded','pstate.btype','landing-pad-kind'],
    },
  });
}

function rebuiltBundle(bundle, { operations, possibleFaults, completeness, unknownEffects = null, statePreservation = null, metadata = {} }) {
  return createMachineEffectBundle({
    instructionId:bundle.instructionId,
    architectureId:bundle.architectureId,
    mode:bundle.mode,
    operations,
    controlEffect:bundle.controlEffect,
    possibleFaults,
    origin:bundle.origin,
    completeness,
    ...(unknownEffects == null ? {} : { unknownEffects }),
    ...(statePreservation == null ? {} : { statePreservation }),
    metadata:{ ...(bundle.metadata || {}), ...metadata },
  });
}

function guardFaultCondition(guardState, landing) {
  return {
    kind:'and',
    terms:[
      {
        kind:'mapped-page-guarded',
        value:guardState.mappedPageGuarded == null ? 'unknown' : guardState.mappedPageGuarded,
        source:guardState.source,
        evidence:guardState.evidence,
      },
      {
        kind:'not',
        condition:{ kind:'bti-compatible', btype:'pstate.btype', landingPadKind:landing.kind },
      },
    ],
  };
}

function guardRead() {
  const value = createTemporaryValue('bti:page-guarded', createBitVectorValue(1));
  return {
    value,
    operation:createMachineOperation({
      kind:'register-read',
      register:createRegisterValue(ARM64_BTI_PAGE_GUARD_STATE_ID, 1, { view:ARM64_BTI_PAGE_GUARD_STATE_ID }),
      value,
      metadata:{ architecture:'arm64', externalState:'executable-page-guarded', authority:'runtime-mapping' },
    }),
  };
}

export function decorateArm64BtiGuardedPageEffects(instruction, bundle, context = {}) {
  if (!bundle || mnemonicOf(instruction) !== 'bti') return bundle;
  const guardState = normalizeArm64BtiGuardedPageState(
    context.btiGuardedPage ?? context.guardedPageState ?? context.pageGuardState ?? null,
  );
  const landing = landingKindOf(instruction);

  if (guardState.state === 'unguarded') {
    return rebuiltBundle(bundle, {
      operations:[],
      possibleFaults:[],
      completeness:'exact',
      statePreservation:{ proven:true, reason:'BTI on an observed non-guarded executable page is architecturally NOP-like' },
      metadata:{
        btiGuardedPage:guardState,
        btiCheck:'skipped-non-guarded-page',
        loaderPolicyDoesNotImplyMappedState:true,
      },
    });
  }

  const intrinsicIndex = bundle.operations.findIndex((operation) => operation.kind === 'intrinsic' && operation.intrinsicId === 'arm64.system.bti');
  if (intrinsicIndex < 0 || !landing) {
    return rebuiltBundle(bundle, {
      operations:bundle.operations,
      possibleFaults:bundle.possibleFaults,
      completeness:'partial',
      unknownEffects:{ categories:['control','faults'], reason:intrinsicIndex < 0 ? 'bti-intrinsic-missing' : 'bti-landing-pad-kind-unresolved' },
      metadata:{ btiGuardedPage:guardState, btiCheck:'partial' },
    });
  }

  const operations = bundle.operations.slice();
  let guardValue;
  if (guardState.state === 'guarded') {
    guardValue = createBitVectorValue(1, 1);
  } else {
    const read = guardRead();
    operations.splice(intrinsicIndex, 0, read.operation);
    guardValue = read.value;
  }
  const adjustedIntrinsicIndex = intrinsicIndex + (guardState.state === 'unknown' ? 1 : 0);
  operations[adjustedIntrinsicIndex] = rebuildIntrinsic(operations[adjustedIntrinsicIndex], guardValue, landing);
  const possibleFaults = [{
    kind:'branch-target-exception',
    condition:guardFaultCondition(guardState, landing),
    detail:{
      guardedPageState:guardState.state,
      landingPadKind:landing.kind,
      loaderPolicy:guardState.loaderPolicy,
    },
  }];

  if (guardState.state === 'guarded') {
    return rebuiltBundle(bundle, {
      operations,
      possibleFaults,
      completeness:'exact-with-intrinsic',
      metadata:{
        btiGuardedPage:guardState,
        btiCheck:'guarded-page-compatibility',
        loaderPolicyDoesNotImplyMappedState:true,
      },
    });
  }

  return rebuiltBundle(bundle, {
    operations,
    possibleFaults,
    completeness:'partial',
    unknownEffects:{
      categories:['control','faults'],
      reason:'bti-mapped-page-guarded-state-unresolved',
      detail:{ loaderPolicy:guardState.loaderPolicy },
    },
    metadata:{
      btiGuardedPage:guardState,
      btiCheck:'conditional-on-unknown-page-guard-state',
      loaderPolicyDoesNotImplyMappedState:true,
    },
  });
}
