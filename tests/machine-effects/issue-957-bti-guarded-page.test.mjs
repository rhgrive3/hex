import assert from 'node:assert/strict';
import { parseAarch64GnuProperty } from '../../js/binary/elf-gnu-property.js';
import { parseELF } from '../../js/binary/elf-loader.js';
import {
  ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION,
  liftArm64MachineEffects,
} from '../../js/targets/architecture/arm64/effects/index.js';
import {
  ARM64_BTI_PAGE_GUARD_STATE_ID,
  arm64BtiGuardedPageStateFromImage,
} from '../../js/targets/architecture/arm64/effects/bti-guard-state.js';

function u16(view, offset, value) { view.setUint16(offset, value, true); }
function u32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }
function u64(view, offset, value) { view.setBigUint64(offset, BigInt(value), true); }

function elf64Aarch64Property(featureBits = 1) {
  const noteOffset = 120;
  const noteSize = 32;
  const bytes = new Uint8Array(noteOffset + noteSize);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f,0x45,0x4c,0x46,2,1,1,0], 0);
  u16(view, 16, 2);       // ET_EXEC
  u16(view, 18, 183);     // EM_AARCH64
  u32(view, 20, 1);
  u64(view, 24, 0);
  u64(view, 32, 64);      // e_phoff
  u64(view, 40, 0);       // no section table required
  u32(view, 48, 0);
  u16(view, 52, 64);
  u16(view, 54, 56);
  u16(view, 56, 1);
  u16(view, 58, 64);
  u16(view, 60, 0);
  u16(view, 62, 0);

  // PT_GNU_PROPERTY
  u32(view, 64, 0x6474e553);
  u32(view, 68, 4);
  u64(view, 72, noteOffset);
  u64(view, 80, 0);
  u64(view, 88, 0);
  u64(view, 96, noteSize);
  u64(view, 104, noteSize);
  u64(view, 112, 8);

  // NT_GNU_PROPERTY_TYPE_0, name "GNU\0", 16-byte ELF64 property payload.
  u32(view, noteOffset + 0, 4);
  u32(view, noteOffset + 4, 16);
  u32(view, noteOffset + 8, 5);
  bytes.set([0x47,0x4e,0x55,0], noteOffset + 12);
  u32(view, noteOffset + 16, 0xc0000000);
  u32(view, noteOffset + 20, 4);
  u32(view, noteOffset + 24, featureBits);
  return bytes;
}

function context(id, btiGuardedPage) {
  return {
    instructionId:id,
    origin:{ instructionIds:[id] },
    btiGuardedPage,
  };
}

function bti(kind = 'c') {
  return { mnemonic:'bti', ops:[{ k:'other', text:kind }] };
}

assert.equal(ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION, '3');

// Non-guarded mapped page: BTI is NOP-like. No compatibility fault and no
// unnecessary BTYPE dependency are allowed.
{
  const result = liftArm64MachineEffects(bti('c'), context('bti-unguarded', {
    mappedPageGuarded:false,
    source:'runtime-page-table',
    evidence:{ mappingId:'map-1' },
    loaderPolicy:{ btiRequested:true },
  }));
  assert.equal(result.completeness, 'exact');
  assert.deepEqual(result.operations, []);
  assert.deepEqual(result.possibleFaults, []);
  assert.equal(result.statePreservation.proven, true);
  assert.equal(result.metadata.btiCheck, 'skipped-non-guarded-page');
}

// Guarded mapped page: page-guard + BTYPE + landing-pad kind are all explicit
// inputs to the compatibility intrinsic, and the fault is gated by pageGuarded.
{
  const result = liftArm64MachineEffects(bti('jc'), context('bti-guarded', {
    mappedPageGuarded:true,
    source:'runtime-page-table',
    evidence:{ mappingId:'map-2' },
  }));
  assert.equal(result.completeness, 'exact-with-intrinsic');
  const intrinsic = result.operations.find((operation) => operation.kind === 'intrinsic' && operation.intrinsicId === 'arm64.system.bti');
  assert.ok(intrinsic);
  assert.equal(intrinsic.effectSummary.inputs.length, 3);
  assert.deepEqual(intrinsic.metadata.inputOrder, ['page-guarded','pstate.btype','landing-pad-kind']);
  assert.equal(intrinsic.metadata.landingPadKind, 'jc');
  assert.equal(result.possibleFaults.length, 1);
  assert.equal(result.possibleFaults[0].condition.kind, 'and');
  assert.equal(result.possibleFaults[0].condition.terms[0].kind, 'mapped-page-guarded');
  assert.equal(result.possibleFaults[0].condition.terms[0].value, true);
  assert.equal(result.possibleFaults[0].condition.terms[1].condition.kind, 'bti-compatible');
}

// Unknown actual page state: preserve a typed external mapping-state input and
// remain partial. Loader policy does not manufacture a guarded-page fact.
{
  const result = liftArm64MachineEffects(bti('j'), context('bti-unknown', {
    state:'unknown',
    source:'loader-policy-is-not-runtime-page-state',
    loaderPolicy:{ loaderPolicy:'bti-requested', btiRequested:true },
  }));
  assert.equal(result.completeness, 'partial');
  assert.equal(result.unknownEffects.reason, 'bti-mapped-page-guarded-state-unresolved');
  const guardRead = result.operations.find((operation) =>
    operation.kind === 'register-read' && operation.register.registerId === ARM64_BTI_PAGE_GUARD_STATE_ID);
  assert.ok(guardRead);
  assert.equal(guardRead.register.widthBits, 1);
  assert.equal(result.possibleFaults[0].condition.terms[0].value, 'unknown');
}

// GNU property parser: FEATURE_1_BTI is loader policy evidence only.
{
  const present = parseAarch64GnuProperty(elf64Aarch64Property(1));
  assert.equal(present.loaderPolicy, 'bti-requested');
  assert.equal(present.btiRequested, true);
  assert.equal(present.mappedPageGuarded, 'unknown');
  assert.ok(present.evidence.some((item) => item.propertyType === 0xc0000000));

  const absent = parseAarch64GnuProperty(elf64Aarch64Property(0));
  assert.equal(absent.loaderPolicy, 'bti-not-requested');
  assert.equal(absent.btiRequested, false);
  assert.equal(absent.mappedPageGuarded, 'unknown');
}

// Public ELF loader preserves the same policy evidence in BinaryImage metadata.
{
  const image = parseELF(elf64Aarch64Property(1));
  assert.equal(image.arch, 'arm64');
  assert.equal(image.metadata.arm64Bti.btiRequested, true);
  assert.equal(image.metadata.arm64Bti.mappedPageGuarded, 'unknown');
}

// Image policy alone remains unknown. Only actual mapping observation resolves
// guarded-page state, and it may explicitly contradict the loader request.
{
  const image = {
    metadata:{ arm64Bti:{ loaderPolicy:'bti-requested', btiRequested:true, mappedPageGuarded:'unknown' } },
  };
  const policyOnly = arm64BtiGuardedPageStateFromImage(image, 0x1000n);
  assert.equal(policyOnly.state, 'unknown');
  assert.equal(policyOnly.loaderPolicy.btiRequested, true);

  const mappedFalse = arm64BtiGuardedPageStateFromImage(image, 0x1000n, {
    mappedPageGuarded:false,
    source:'runtime-page-table',
    evidence:{ page:'0x1000' },
  });
  assert.equal(mappedFalse.state, 'unguarded');
  assert.equal(mappedFalse.mappedPageGuarded, false);
  assert.equal(mappedFalse.loaderPolicy.btiRequested, true);
}

console.log('issue #957 BTI guarded-page / ELF GNU property regression: PASS');
