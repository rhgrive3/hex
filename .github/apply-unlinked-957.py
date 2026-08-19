from pathlib import Path

# Pure, bounded GNU property decoder. It owns only note/property decoding; ELF
# mapping policy remains in elf.js and runtime mapping truth remains external.
property_file = Path('js/binary/elf-gnu-property.js')
property_file.write_text(r'''const NT_GNU_PROPERTY_TYPE_0 = 5;
const GNU_PROPERTY_AARCH64_FEATURE_1_AND = 0xc0000000;
const GNU_PROPERTY_AARCH64_FEATURE_1_BTI = 1;
const GNU_PROPERTY_AARCH64_FEATURE_1_PAC = 2;

function align(value, boundary) {
  return Math.ceil(value / boundary) * boundary;
}

function u32(bytes, offset, littleEndian) {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  return view.getUint32(0, littleEndian);
}

export function parseAarch64GnuPropertyNotes(input, { bits = 64, littleEndian = true, maxBytes = 1024 * 1024 } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input ?? 0);
  if (bytes.length > maxBytes) return Object.freeze({ present:false, bti:false, pac:false, truncated:true, reason:'gnu-property-note-budget-exceeded' });
  const noteAlign = 4;
  const propertyAlign = bits === 64 ? 8 : 4;
  let cursor = 0;
  let present = false;
  let feature1And = null;
  let malformed = false;

  while (cursor + 12 <= bytes.length) {
    const namesz = u32(bytes, cursor, littleEndian);
    const descsz = u32(bytes, cursor + 4, littleEndian);
    const type = u32(bytes, cursor + 8, littleEndian);
    if (namesz == null || descsz == null || type == null) { malformed = true; break; }
    cursor += 12;
    const nameEnd = cursor + namesz;
    if (nameEnd > bytes.length) { malformed = true; break; }
    const name = new TextDecoder().decode(bytes.subarray(cursor, Math.max(cursor, nameEnd - (namesz && bytes[nameEnd - 1] === 0 ? 1 : 0))));
    cursor = align(nameEnd, noteAlign);
    const descStart = cursor;
    const descEnd = descStart + descsz;
    if (descEnd > bytes.length) { malformed = true; break; }

    if (type === NT_GNU_PROPERTY_TYPE_0 && name === 'GNU') {
      present = true;
      let p = descStart;
      while (p + 8 <= descEnd) {
        const propertyType = u32(bytes, p, littleEndian);
        const dataSize = u32(bytes, p + 4, littleEndian);
        if (propertyType == null || dataSize == null) { malformed = true; break; }
        const dataStart = p + 8;
        const dataEnd = dataStart + dataSize;
        if (dataEnd > descEnd) { malformed = true; break; }
        if (propertyType === GNU_PROPERTY_AARCH64_FEATURE_1_AND && dataSize >= 4) {
          const value = u32(bytes, dataStart, littleEndian);
          if (value != null) feature1And = feature1And == null ? value : (feature1And & value);
        }
        p = align(dataEnd, propertyAlign);
      }
    }
    cursor = align(descEnd, noteAlign);
  }

  return Object.freeze({
    present,
    feature1And,
    bti:feature1And != null && (feature1And & GNU_PROPERTY_AARCH64_FEATURE_1_BTI) !== 0,
    pac:feature1And != null && (feature1And & GNU_PROPERTY_AARCH64_FEATURE_1_PAC) !== 0,
    malformed,
    truncated:false,
  });
}
''')

# ELF loader: retain GNU-property evidence and distinguish image-level loader
# policy from the actual runtime page mapping. Property absence proves the image
# does not request guarded executable mappings; property presence does NOT prove
# a particular runtime page is guarded.
elf = Path('js/binary/elf.js')
text = elf.read_text()
old = "import { parseRiscvAttributes, parseRiscvMappingSymbol } from './riscv-isa.js';"
new = "import { parseRiscvAttributes, parseRiscvMappingSymbol } from './riscv-isa.js';\nimport { parseAarch64GnuPropertyNotes } from './elf-gnu-property.js';"
if text.count(old) != 1:
    raise SystemExit(f'#957 ELF import anchor expected once, found {text.count(old)}')
text = text.replace(old, new, 1)
old = "const PT_GNU_EH_FRAME = 0x6474e550;"
new = "const PT_GNU_EH_FRAME = 0x6474e550;\nconst PT_GNU_PROPERTY = 0x6474e553;\nconst SHT_NOTE = 7;"
if text.count(old) != 1:
    raise SystemExit(f'#957 ELF constants anchor expected once, found {text.count(old)}')
text = text.replace(old, new, 1)
old = """  nameSections(r, rawSections, h);\n  let riscvFileIsa = null;\n"""
new = """  nameSections(r, rawSections, h);\n  if (image.arch === 'arm64') attachAarch64BtiLoaderEvidence(r, rawSections, programHeaders, image, bits, littleEndian);\n  let riscvFileIsa = null;\n"""
if text.count(old) != 1:
    raise SystemExit(f'#957 ELF integration anchor expected once, found {text.count(old)}')
text = text.replace(old, new, 1)
anchor = """function alignUp(value, alignment) {\n"""
helper = r'''function attachAarch64BtiLoaderEvidence(r, sections, programHeaders, image, bits, littleEndian) {
  const ranges = [];
  for (const section of sections) {
    if (section.type === SHT_NOTE && (section.name === '.note.gnu.property' || section.name === '.note.gnu.build-id' || section.name === '.note.gnu.property')) {
      ranges.push({ source:`section:${section.name || section.index}`, offset:section.offset, size:section.size });
    }
  }
  for (let index = 0; index < programHeaders.length; index++) {
    const ph = programHeaders[index];
    if (ph.type === PT_GNU_PROPERTY && ph.filesz > 0n) ranges.push({ source:`program-header:${index}`, offset:ph.offset, size:ph.filesz });
  }

  let notePresent = false, bti = false, pac = false, malformed = false;
  const evidence = [];
  const seen = new Set();
  for (const range of ranges) {
    const offset = safeOffset(range.offset), size = safeOffset(range.size);
    if (offset == null || size == null || size <= 0 || size > 1024 * 1024 || offset > r.length || size > r.length - offset) {
      evidence.push({ source:range.source, status:'invalid-or-budgeted-range' });
      continue;
    }
    const key = `${offset}:${size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const parsed = parseAarch64GnuPropertyNotes(r.bytes.subarray(offset, offset + size), { bits, littleEndian });
    notePresent ||= parsed.present;
    bti ||= parsed.bti;
    pac ||= parsed.pac;
    malformed ||= parsed.malformed || parsed.truncated;
    evidence.push({ source:range.source, status:parsed.present ? 'gnu-property' : 'no-gnu-property', bti:parsed.bti, pac:parsed.pac, malformed:parsed.malformed });
  }

  const requestedGuardedExecutableMappings = bti;
  const staticallyKnownCurrentPageGuarded = bti ? null : false;
  image.metadata.branchTargetIdentification = {
    imageFeature:{
      source:'elf-gnu-property',
      gnuPropertyPresent:notePresent,
      bti,
      pac,
      malformed,
      evidence,
    },
    loaderPolicy:{
      requestedGuardedExecutableMappings,
      source:bti ? 'GNU_PROPERTY_AARCH64_FEATURE_1_BTI' : 'BTI-property-absent',
    },
    actualMapping:{ currentPageGuarded:null, source:'runtime-mapping-required' },
    staticFallback:{ currentPageGuarded:staticallyKnownCurrentPageGuarded, source:bti ? 'runtime-required' : 'image-does-not-request-BTI' },
  };
  image.metadata.machineEffectsContext = {
    ...(image.metadata.machineEffectsContext || {}),
    branchTargetIdentification:{
      currentPageGuarded:staticallyKnownCurrentPageGuarded,
      source:bti ? 'elf-bti-property-runtime-mapping-required' : 'elf-bti-property-absent',
      imageRequestsBti:bti,
      loaderPolicyKnown:true,
      actualMappingKnown:false,
    },
  };
}

function alignUp(value, alignment) {
'''
if text.count(anchor) != 1:
    raise SystemExit(f'#957 ELF helper anchor expected once, found {text.count(anchor)}')
text = text.replace(anchor, helper, 1)
elf.write_text(text)

# Analysis entry: consume a loader-produced machine-effects hint when the caller
# provides the BinaryImage/metadata, while letting explicit runtime context win.
semantic = Path('js/analysis/semantic-function.js')
text = semantic.read_text()
old = """    machineEffectsContext:input.machineEffectsContext ?? {\n      dataEndianness:input.dataEndianness,\n      instructionEndianness:input.instructionEndianness,\n    },\n"""
new = """    machineEffectsContext:input.machineEffectsContext ?? {\n      ...(input.binaryImage?.metadata?.machineEffectsContext ?? input.binaryMetadata?.machineEffectsContext ?? {}),\n      dataEndianness:input.dataEndianness,\n      instructionEndianness:input.instructionEndianness,\n    },\n"""
if text.count(old) != 1:
    raise SystemExit(f'#957 semantic context bridge anchor expected once, found {text.count(old)}')
semantic.write_text(text.replace(old, new, 1))

# BTI: non-guarded page is NOP-like; guarded page checks BTYPE; unknown guard
# remains an explicit typed input and partial/conditional result.
system = Path('js/targets/architecture/arm64/effects/system.js')
text = system.read_text()
start = text.index('function bti(instruction, context, ops) {')
end = text.index('\nfunction trap(instruction, context, mnemonic, ops) {', start)
new_bti = r'''function bti(instruction, context, ops) {
  const landingPadKind = String(ops[0]?.text || instruction?.operands || '').toLowerCase() || 'encoded';
  const guardedRaw = context?.branchTargetIdentification?.currentPageGuarded;
  const guarded = guardedRaw === true ? true : guardedRaw === false ? false : null;
  const contextSource = String(context?.branchTargetIdentification?.source || 'unavailable');

  if (guarded === false) {
    return bundle(instruction, context, {
      operations:[],
      completeness:'exact',
      possibleFaults:[],
      statePreservation:{ proven:true, reason:'BTI is NOP-like on a non-guarded page' },
      metadata:{
        bti:{ landingPadKind, pageGuarded:false, guardSource:contextSource, compatibilityCheckActive:false },
      },
    });
  }

  const operations = [];
  const btype = temp('bti:btype', createBitVectorValue(2));
  operations.push(createMachineOperation({
    kind:'register-read', register:createRegisterValue('pstate.btype', 2), value:btype,
  }));
  const guardedInput = guarded === true ? createBitVectorValue(1, 1n) : createBitVectorValue(1);
  const operation = completeIntrinsic({
    id:'arm64.system.bti', inputs:[guardedInput, btype], outputs:[], registersRead:['pstate.btype'], registersWritten:[],
    memoryRead:{scope:'none'}, memoryWrite:{scope:'none'}, controlEffects:[], determinism:'input-dependent', symbolicDetail:'summary-only',
    metadata:{ landingPadKind, guardedPageInputIndex:0, btypeInputIndex:1, guardSource:contextSource },
  });
  operations.push(operation);
  const possibleFaults = [{
    kind:'branch-target-exception',
    condition:{
      kind:'all-of',
      terms:[
        { kind:'page-guarded', inputIndex:0, expected:true },
        { kind:'bti-incompatible', btypeInputIndex:1, landingPadKind },
      ],
    },
  }];
  if (guarded === true) {
    return bundle(instruction, context, {
      operations,
      possibleFaults,
      completeness:'exact-with-intrinsic',
      metadata:{ bti:{ landingPadKind, pageGuarded:true, guardSource:contextSource, compatibilityCheckActive:true } },
    });
  }
  return partial(
    instruction,
    context,
    'arm64-bti-current-page-guarded-state-unavailable',
    ['faults','control','other'],
    operations,
    { kind:'fallthrough' },
    possibleFaults,
  );
}
'''
text = text[:start] + new_bti + text[end:]
system.write_text(text)

# Semantic version changes because the same BTI bytes now depend on explicit
# loader/runtime page state.
index = Path('js/targets/architecture/arm64/effects/index.js')
text = index.read_text()
old = "export const ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION = '3';"
if old not in text:
    old = "export const ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION = '2';"
if text.count(old) != 1:
    raise SystemExit(f'#957 semantic version anchor expected once, found {text.count(old)}')
version = old.split("'")[1]
try:
    next_version = str(int(version) + 1)
except Exception:
    next_version = version + '.1'
index.write_text(text.replace(old, f"export const ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION = '{next_version}';", 1))

# Focused BTI semantics and GNU-property parser regressions.
test = Path('tests/machine-effects/issue-957-bti-guarded-page.test.mjs')
test.write_text(r'''import assert from 'node:assert/strict';
import { liftArm64SystemEffects } from '../../js/targets/architecture/arm64/effects/system.js';
import { parseAarch64GnuPropertyNotes } from '../../js/binary/elf-gnu-property.js';

let seq = 0;
function lift(guarded) {
  const instructionId = `issue-957-${seq++}`;
  return liftArm64SystemEffects({ mnemonic:'bti', operands:'c', ops:[{ k:'ident', text:'c' }] }, {
    instructionId,
    origin:{ instructionIds:[instructionId] },
    branchTargetIdentification:{ currentPageGuarded:guarded, source:'fixture' },
  });
}

const unguarded = lift(false);
assert.equal(unguarded.completeness, 'exact');
assert.equal(unguarded.possibleFaults.length, 0, 'non-guarded BTI must not produce a Branch Target Exception candidate');
assert.equal(unguarded.operations.length, 0, 'non-guarded BTI is NOP-like');
assert.equal(unguarded.statePreservation.proven, true);
assert.equal(unguarded.metadata.bti.compatibilityCheckActive, false);

const guarded = lift(true);
assert.equal(guarded.completeness, 'exact-with-intrinsic');
assert.equal(guarded.possibleFaults.length, 1);
const guardedIntrinsic = guarded.operations.find((op) => op.kind === 'intrinsic' && op.intrinsicId === 'arm64.system.bti');
assert.ok(guardedIntrinsic);
assert.equal(guardedIntrinsic.effectSummary.inputs.length, 2, 'guarded-page and BTYPE must both be typed intrinsic inputs');
assert.equal(guardedIntrinsic.metadata.guardedPageInputIndex, 0);
assert.equal(guarded.possibleFaults[0].condition.terms[0].kind, 'page-guarded');
assert.equal(guarded.possibleFaults[0].condition.terms[1].kind, 'bti-incompatible');

const unknown = lift(undefined);
assert.equal(unknown.completeness, 'partial');
assert.ok(unknown.unknownEffects.categories.includes('faults'));
assert.ok(unknown.operations.some((op) => op.kind === 'unknown' && op.reason === 'arm64-bti-current-page-guarded-state-unavailable'));
const unknownIntrinsic = unknown.operations.find((op) => op.kind === 'intrinsic' && op.intrinsicId === 'arm64.system.bti');
assert.equal(unknownIntrinsic.effectSummary.inputs.length, 2);
assert.equal(unknown.possibleFaults.length, 1, 'unknown guard remains a conditional candidate, not an unconditional fault');

function gnuPropertyNote(featureBits) {
  const bytes = new Uint8Array(32);
  const v = new DataView(bytes.buffer);
  v.setUint32(0, 4, true);   // namesz
  v.setUint32(4, 16, true);  // descsz
  v.setUint32(8, 5, true);   // NT_GNU_PROPERTY_TYPE_0
  bytes.set([0x47,0x4e,0x55,0], 12); // GNU\0
  v.setUint32(16, 0xc0000000, true); // AARCH64_FEATURE_1_AND
  v.setUint32(20, 4, true);
  v.setUint32(24, featureBits, true);
  return bytes;
}
const withBti = parseAarch64GnuPropertyNotes(gnuPropertyNote(1), { bits:64, littleEndian:true });
assert.equal(withBti.present, true);
assert.equal(withBti.bti, true);
assert.equal(withBti.pac, false);
const withoutBti = parseAarch64GnuPropertyNotes(gnuPropertyNote(2), { bits:64, littleEndian:true });
assert.equal(withoutBti.present, true);
assert.equal(withoutBti.bti, false);
assert.equal(withoutBti.pac, true);

console.log('issue #957 BTI guarded-page/ELF property regressions: PASS');
''')
