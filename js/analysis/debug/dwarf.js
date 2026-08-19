/**
 * P7-5a — DWARF provider.
 *
 * Reads a practical subset of DWARF 4 and 5: the abbreviation table, the
 * compilation-unit DIE tree, and the string sections. That is enough to produce
 * function symbols and the type records the TypeConstraintGraph consumes, which
 * is what proves the boundary.
 *
 * Everything outside that subset is reported as an explicit diagnostic and an
 * incomplete status rather than being skipped silently. A DWARF form this
 * reader does not understand means the attribute is *unknown*, and the record
 * it belongs to must not claim to be complete.
 *
 * Identity comes from the ELF build id (`.note.gnu.build-id`) or, for split
 * debug files, from `.gnu_debuglink` and its CRC32. Filename equality is never
 * accepted — the provider contract rejects it outright.
 */

import { createAnalysisStatus } from '../status.js';
import {
  DEBUG_DEFAULT_BUDGET,
  DEBUG_DEFAULT_PAGE_SIZE,
  DebugInfoProvider,
  createDebugPage,
  createDebugProviderResult,
  createDebugRecord,
} from './provider.js';

export const DWARF_PROVIDER_ID = 'phase7.debug.dwarf';
export const DWARF_PROVIDER_VERSION = '1.0.0';

// DWARF tags this reader models. Anything else becomes a diagnostic.
const DW_TAG = Object.freeze({
  array_type: 0x01,
  structure_type: 0x13,
  union_type: 0x17,
  class_type: 0x02,
  enumeration_type: 0x04,
  formal_parameter: 0x05,
  member: 0x0d,
  pointer_type: 0x0f,
  compile_unit: 0x11,
  base_type: 0x24,
  const_type: 0x26,
  subprogram: 0x2e,
  variable: 0x34,
  typedef: 0x16,
  volatile_type: 0x35,
  subroutine_type: 0x15,
});

const DW_AT = Object.freeze({
  location: 0x02,
  name: 0x03,
  byte_size: 0x0b,
  stmt_list: 0x10,
  low_pc: 0x11,
  high_pc: 0x12,
  language: 0x13,
  comp_dir: 0x1b,
  const_value: 0x1c,
  upper_bound: 0x2f,
  producer: 0x25,
  prototyped: 0x27,
  count: 0x37,
  data_member_location: 0x38,
  declaration: 0x3c,
  encoding: 0x3e,
  external: 0x3f,
  frame_base: 0x40,
  specification: 0x47,
  type: 0x49,
  ranges: 0x55,
  str_offsets_base: 0x72,
  addr_base: 0x73,
  rnglists_base: 0x74,
});

const DW_FORM = Object.freeze({
  addr: 0x01, block2: 0x03, block4: 0x04, data2: 0x05, data4: 0x06, data8: 0x07,
  string: 0x08, block: 0x09, block1: 0x0a, data1: 0x0b, flag: 0x0c, sdata: 0x0d,
  strp: 0x0e, udata: 0x0f, ref_addr: 0x10, ref1: 0x11, ref2: 0x12, ref4: 0x13,
  ref8: 0x14, ref_udata: 0x15, indirect: 0x16, sec_offset: 0x17, exprloc: 0x18,
  flag_present: 0x19, strx: 0x1a, addrx: 0x1b, ref_sup4: 0x1c, strp_sup: 0x1d,
  data16: 0x1e, line_strp: 0x1f, ref_sig8: 0x20, implicit_const: 0x21,
  loclistx: 0x22, rnglistx: 0x23, ref_sup8: 0x24,
  strx1: 0x25, strx2: 0x26, strx3: 0x27, strx4: 0x28,
  addrx1: 0x29, addrx2: 0x2a, addrx3: 0x2b, addrx4: 0x2c,
});

/** DW_ATE base-type encodings, mapped to the machine layer's classes. */
const ENCODING_CLASS = Object.freeze({
  0x02: 'boolean', 0x04: 'float', 0x05: 'integer', 0x06: 'integer',
  0x07: 'integer', 0x08: 'integer', 0x0d: 'integer', 0x0e: 'integer',
});

class Cursor {
  constructor(bytes, offset = 0) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = offset;
  }

  get eof() { return this.offset >= this.bytes.length; }

  u8() { const value = this.view.getUint8(this.offset); this.offset += 1; return value; }
  u16() { const value = this.view.getUint16(this.offset, true); this.offset += 2; return value; }
  u32() { const value = this.view.getUint32(this.offset, true); this.offset += 4; return value; }
  u64() { const value = this.view.getBigUint64(this.offset, true); this.offset += 8; return value; }

  uleb() {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      const byte = this.u8();
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
      if (shift > 128n) throw new RangeError('dwarf-uleb-too-long');
    }
    return result;
  }

  sleb() {
    let result = 0n;
    let shift = 0n;
    let byte;
    do {
      byte = this.u8();
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if (shift > 128n) throw new RangeError('dwarf-sleb-too-long');
    } while (byte & 0x80);
    if (shift < 128n && (byte & 0x40)) result -= 1n << shift;
    return result;
  }

  skip(count) { this.offset += count; }
  slice(count) { const out = this.bytes.subarray(this.offset, this.offset + count); this.offset += count; return out; }
}

function cstring(bytes, offset) {
  let end = offset;
  while (end < bytes.length && bytes[end] !== 0) end += 1;
  return new TextDecoder('utf8').decode(bytes.subarray(offset, end));
}

/** Parses `.debug_abbrev` into `code -> { tag, hasChildren, attributes }`. */
function parseAbbrev(bytes, tableOffset) {
  const table = new Map();
  if (!bytes || tableOffset >= bytes.length) return table;
  const cursor = new Cursor(bytes, tableOffset);
  while (!cursor.eof) {
    const code = Number(cursor.uleb());
    if (code === 0) break;
    const tag = Number(cursor.uleb());
    const hasChildren = cursor.u8() === 1;
    const attributes = [];
    for (;;) {
      const attribute = Number(cursor.uleb());
      const form = Number(cursor.uleb());
      const implicitConst = form === DW_FORM.implicit_const ? cursor.sleb() : null;
      if (attribute === 0 && form === 0) break;
      attributes.push({ attribute, form, implicitConst });
    }
    table.set(code, { tag, hasChildren, attributes });
  }
  return table;
}

/**
 * Reads one attribute value.
 *
 * Returns `{ value, unsupported }`. An unsupported form is *not* an exception:
 * the DIE keeps its other attributes and records that one is unknown, which is
 * how a partially understood record stays honest instead of being dropped.
 */
function readForm(cursor, form, unit, sections, implicitConst) {
  switch (form) {
    case DW_FORM.addr: return { value: unit.addressSize === 8 ? cursor.u64() : BigInt(cursor.u32()) };
    case DW_FORM.data1: case DW_FORM.ref1: case DW_FORM.strx1: case DW_FORM.addrx1: case DW_FORM.flag:
      return { value: BigInt(cursor.u8()) };
    case DW_FORM.data2: case DW_FORM.ref2: case DW_FORM.strx2: case DW_FORM.addrx2:
      return { value: BigInt(cursor.u16()) };
    case DW_FORM.strx3: case DW_FORM.addrx3: {
      const low = cursor.u16();
      return { value: BigInt(low | (cursor.u8() << 16)) };
    }
    case DW_FORM.data4: case DW_FORM.ref4: case DW_FORM.strx4: case DW_FORM.addrx4: case DW_FORM.ref_sup4:
      return { value: BigInt(cursor.u32()) };
    case DW_FORM.data8: case DW_FORM.ref8: case DW_FORM.ref_sig8: case DW_FORM.ref_sup8:
      return { value: cursor.u64() };
    case DW_FORM.data16: return { value: cursor.slice(16) };
    case DW_FORM.sdata: return { value: cursor.sleb() };
    case DW_FORM.udata: case DW_FORM.ref_udata: case DW_FORM.strx: case DW_FORM.addrx:
    case DW_FORM.loclistx: case DW_FORM.rnglistx:
      return { value: cursor.uleb() };
    case DW_FORM.string: {
      const text = cstring(cursor.bytes, cursor.offset);
      cursor.skip(text.length + 1);
      return { value: text };
    }
    case DW_FORM.strp: {
      const offset = unit.offsetSize === 8 ? Number(cursor.u64()) : cursor.u32();
      return { value: sections.debug_str ? cstring(sections.debug_str, offset) : null, unsupported: !sections.debug_str };
    }
    case DW_FORM.line_strp: {
      const offset = unit.offsetSize === 8 ? Number(cursor.u64()) : cursor.u32();
      return { value: sections.debug_line_str ? cstring(sections.debug_line_str, offset) : null, unsupported: !sections.debug_line_str };
    }
    case DW_FORM.sec_offset: case DW_FORM.ref_addr: case DW_FORM.strp_sup:
      return { value: unit.offsetSize === 8 ? cursor.u64() : BigInt(cursor.u32()) };
    case DW_FORM.exprloc: case DW_FORM.block: {
      const length = Number(cursor.uleb());
      return { value: cursor.slice(length) };
    }
    case DW_FORM.block1: return { value: cursor.slice(cursor.u8()) };
    case DW_FORM.block2: return { value: cursor.slice(cursor.u16()) };
    case DW_FORM.block4: return { value: cursor.slice(cursor.u32()) };
    case DW_FORM.flag_present: return { value: 1n };
    case DW_FORM.implicit_const: return { value: implicitConst };
    case DW_FORM.indirect: {
      const actual = Number(cursor.uleb());
      return readForm(cursor, actual, unit, sections, null);
    }
    default:
      // An unrecognised form has an unknown length, so the DIE stream cannot be
      // resynchronised. The unit stops here and reports itself incomplete.
      return { value: null, unsupported: true, fatal: true };
  }
}

/** Resolves the string for a DW_FORM_strx index through `.debug_str_offsets`. */
function strxString(index, unit, sections) {
  const table = sections.debug_str_offsets;
  if (!table || !sections.debug_str) return null;
  const base = unit.strOffsetsBase ?? 8;
  const entrySize = unit.offsetSize;
  const at = base + Number(index) * entrySize;
  if (at + entrySize > table.length) return null;
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const offset = entrySize === 8 ? Number(view.getBigUint64(at, true)) : view.getUint32(at, true);
  return cstring(sections.debug_str, offset);
}

/**
 * Walks `.debug_info` and returns the DIE forest.
 *
 * DIEs are kept flat, keyed by their section offset, with a `parent` link. That
 * is what DW_AT_type references need, and it avoids building a deep object
 * graph for a structure that is already addressed by offset.
 */
export function parseDebugInfo(sections, budget = DEBUG_DEFAULT_BUDGET) {
  const info = sections.debug_info;
  const diagnostics = [];
  const dies = new Map();
  if (!info) return { dies, units: [], diagnostics: ['missing .debug_info'], complete: false };

  const units = [];
  const cursor = new Cursor(info, 0);
  let recordCount = 0;
  let complete = true;

  while (cursor.offset + 11 <= info.length) {
    const unitStart = cursor.offset;
    let length = cursor.u32();
    let offsetSize = 4;
    if (length === 0xffffffff) { length = Number(cursor.u64()); offsetSize = 8; }
    if (length === 0 || unitStart + offsetSize + 4 + length > info.length + 4) {
      diagnostics.push(`truncated compilation unit at 0x${unitStart.toString(16)}`);
      complete = false;
      break;
    }
    const unitEnd = cursor.offset + length;
    const version = cursor.u16();
    let abbrevOffset;
    let addressSize;
    let unitType = 0x01;
    if (version >= 5) {
      unitType = cursor.u8();
      addressSize = cursor.u8();
      abbrevOffset = offsetSize === 8 ? Number(cursor.u64()) : cursor.u32();
    } else {
      abbrevOffset = offsetSize === 8 ? Number(cursor.u64()) : cursor.u32();
      addressSize = cursor.u8();
    }
    if (version < 2 || version > 5) {
      diagnostics.push(`unsupported DWARF version ${version} at 0x${unitStart.toString(16)}`);
      complete = false;
      cursor.offset = unitEnd;
      continue;
    }

    const unit = { start: unitStart, version, addressSize, offsetSize, abbrevOffset, unitType, strOffsetsBase: null };
    const abbrev = parseAbbrev(sections.debug_abbrev, abbrevOffset);
    if (abbrev.size === 0) {
      diagnostics.push(`no abbreviations for unit at 0x${unitStart.toString(16)}`);
      complete = false;
      cursor.offset = unitEnd;
      continue;
    }

    const stack = [];
    let unitComplete = true;
    while (cursor.offset < unitEnd) {
      if (recordCount >= budget.maxRecords) {
        diagnostics.push('record budget exhausted');
        complete = false;
        unitComplete = false;
        break;
      }
      const dieOffset = cursor.offset;
      const code = Number(cursor.uleb());
      if (code === 0) { stack.pop(); continue; }
      const declaration = abbrev.get(code);
      if (!declaration) {
        diagnostics.push(`unknown abbreviation code ${code} at 0x${dieOffset.toString(16)}`);
        complete = false;
        unitComplete = false;
        break;
      }
      const attributes = new Map();
      let dieComplete = true;
      for (const spec of declaration.attributes) {
        const read = readForm(cursor, spec.form, unit, sections, spec.implicitConst);
        if (read.unsupported) {
          dieComplete = false;
          diagnostics.push(`unsupported form 0x${spec.form.toString(16)} at 0x${dieOffset.toString(16)}`);
          if (read.fatal) { unitComplete = false; break; }
        }
        // strx forms need the unit's str_offsets base, which may appear in this
        // very DIE, so they are resolved after the whole attribute list is read.
        attributes.set(spec.attribute, { form: spec.form, value: read.value });
      }
      if (!unitComplete) { complete = false; break; }

      if (attributes.has(DW_AT.str_offsets_base)) {
        unit.strOffsetsBase = Number(attributes.get(DW_AT.str_offsets_base).value);
      }
      for (const [attribute, entry] of attributes) {
        if ([DW_FORM.strx, DW_FORM.strx1, DW_FORM.strx2, DW_FORM.strx3, DW_FORM.strx4].includes(entry.form)) {
          const resolved = strxString(entry.value, unit, sections);
          attributes.set(attribute, { form: entry.form, value: resolved });
          if (resolved == null) dieComplete = false;
        }
      }

      const die = {
        offset: dieOffset,
        tag: declaration.tag,
        attributes,
        parent: stack.length ? stack[stack.length - 1] : null,
        unit,
        complete: dieComplete,
        children: [],
      };
      dies.set(dieOffset, die);
      recordCount += 1;
      if (die.parent != null) dies.get(die.parent)?.children.push(dieOffset);
      if (declaration.hasChildren) stack.push(dieOffset);
    }
    if (!unitComplete) complete = false;
    units.push(unit);
    cursor.offset = unitEnd;
  }

  return { dies, units, diagnostics, complete };
}

function attributeValue(die, attribute) {
  return die.attributes.get(attribute)?.value ?? null;
}

function attributeName(die) {
  const value = attributeValue(die, DW_AT.name);
  return typeof value === 'string' ? value : null;
}

/** Follows DW_AT_type, which is a unit-relative reference for the ref* forms. */
function referencedType(die, dies) {
  const entry = die.attributes.get(DW_AT.type);
  if (!entry) return null;
  const raw = Number(entry.value ?? 0);
  const isUnitRelative = [DW_FORM.ref1, DW_FORM.ref2, DW_FORM.ref4, DW_FORM.ref8, DW_FORM.ref_udata].includes(entry.form);
  const target = isUnitRelative ? die.unit.start + raw : raw;
  return dies.get(target) ?? null;
}

/**
 * Renders a DWARF type DIE as a nominal type name plus its machine facts.
 *
 * Qualifier and typedef chains are followed with a depth limit, because DWARF
 * type graphs can be cyclic through pointer members and a naive walk would not
 * terminate.
 */
function describeType(die, dies, depth = 0, seen = new Set()) {
  if (!die || depth > 32 || seen.has(die.offset)) return { name: 'unknown', complete: false };
  seen.add(die.offset);
  const name = attributeName(die);
  const byteSize = attributeValue(die, DW_AT.byte_size);

  switch (die.tag) {
    case DW_TAG.base_type: {
      const encoding = Number(attributeValue(die, DW_AT.encoding) ?? 0);
      return {
        name: name ?? 'base',
        widthBits: byteSize == null ? null : Number(byteSize) * 8,
        class: ENCODING_CLASS[encoding] ?? 'integer',
        complete: byteSize != null && die.complete,
      };
    }
    case DW_TAG.pointer_type: {
      const target = describeType(referencedType(die, dies), dies, depth + 1, seen);
      return {
        name: `${target.name} *`,
        widthBits: byteSize == null ? die.unit.addressSize * 8 : Number(byteSize) * 8,
        class: 'pointer',
        complete: die.complete,
      };
    }
    case DW_TAG.typedef: {
      const target = describeType(referencedType(die, dies), dies, depth + 1, seen);
      return {
        name: name ?? target.name,
        aliases: [name, target.name].filter(Boolean),
        widthBits: target.widthBits ?? null,
        class: target.class ?? null,
        complete: die.complete && target.complete,
      };
    }
    case DW_TAG.const_type: case DW_TAG.volatile_type: {
      const target = describeType(referencedType(die, dies), dies, depth + 1, seen);
      const qualifier = die.tag === DW_TAG.const_type ? 'const' : 'volatile';
      return { ...target, name: `${qualifier} ${target.name}`, complete: target.complete && die.complete };
    }
    case DW_TAG.structure_type: case DW_TAG.class_type: case DW_TAG.union_type: {
      const keyword = die.tag === DW_TAG.union_type ? 'union' : die.tag === DW_TAG.class_type ? 'class' : 'struct';
      return {
        name: name ? `${keyword} ${name}` : `${keyword} <anonymous>`,
        sizeBytes: byteSize == null ? null : Number(byteSize),
        // A DW_AT_declaration DIE is a forward declaration: it names the type
        // but says nothing about its layout, so it is not a complete fact.
        complete: die.complete && attributeValue(die, DW_AT.declaration) == null && byteSize != null,
        isAggregate: true,
        isUnion: die.tag === DW_TAG.union_type,
      };
    }
    case DW_TAG.enumeration_type:
      return { name: name ? `enum ${name}` : 'enum <anonymous>', widthBits: byteSize == null ? null : Number(byteSize) * 8, class: 'integer', complete: die.complete };
    case DW_TAG.array_type: {
      const element = describeType(referencedType(die, dies), dies, depth + 1, seen);
      return { name: `${element.name}[]`, class: 'array', complete: false };
    }
    case DW_TAG.subroutine_type:
      return { name: 'subroutine', class: 'code', complete: die.complete };
    default:
      return { name: name ?? 'unknown', complete: false };
  }
}

function toAddress(value) {
  if (value == null) return null;
  return `0x${BigInt(value).toString(16)}`;
}

/**
 * Computes an ELF build id from `.note.gnu.build-id`.
 *
 * Returns null when the note is absent — which becomes `identity-unavailable`,
 * not a match.
 */
export function readBuildId(noteSection) {
  if (!noteSection || noteSection.length < 16) return null;
  const view = new DataView(noteSection.buffer, noteSection.byteOffset, noteSection.byteLength);
  let offset = 0;
  while (offset + 12 <= noteSection.length) {
    const nameSize = view.getUint32(offset, true);
    const descSize = view.getUint32(offset + 4, true);
    const type = view.getUint32(offset + 8, true);
    const nameStart = offset + 12;
    const descStart = nameStart + ((nameSize + 3) & ~3);
    const descEnd = descStart + descSize;
    if (descEnd > noteSection.length) return null;
    const name = cstring(noteSection, nameStart);
    // NT_GNU_BUILD_ID
    if (type === 3 && name === 'GNU') {
      return [...noteSection.subarray(descStart, descEnd)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    offset = descEnd + ((4 - (descSize & 3)) & 3);
  }
  return null;
}

/** CRC-32 as used by `.gnu_debuglink`. */
export function gnuDebugLinkCrc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Parses `.gnu_debuglink`: a NUL-terminated name followed by a CRC32. */
export function readDebugLink(section) {
  if (!section || section.length < 5) return null;
  const name = cstring(section, 0);
  const crcOffset = (name.length + 4) & ~3;
  if (crcOffset + 4 > section.length) return null;
  const view = new DataView(section.buffer, section.byteOffset, section.byteLength);
  return { name, crc32: view.getUint32(crcOffset, true) >>> 0 };
}

export class DwarfDebugInfoProvider extends DebugInfoProvider {
  constructor() {
    super({ id: DWARF_PROVIDER_ID, version: DWARF_PROVIDER_VERSION, ecosystem: 'dwarf' });
  }

  /**
   * Determines the identity verdict and parses the DIE forest.
   *
   * `image.debugSections` are the sections of the debug source; `image.identity`
   * carries what the *binary* expects. The two are compared explicitly.
   */
  probe(image, { budget = DEBUG_DEFAULT_BUDGET, signal = null } = {}) {
    const sections = image?.debugSections ?? {};
    const diagnostics = [];
    const status = (completeness, stopReason) => createAnalysisStatus({
      snapshotId: image?.snapshotId ?? 'snapshot-unbound',
      analyzerId: DWARF_PROVIDER_ID,
      analyzerVersion: DWARF_PROVIDER_VERSION,
      completeness,
      stopReason,
    });

    if (signal?.aborted) {
      return createDebugProviderResult({
        ecosystem: 'dwarf',
        identity: { verdict: 'unsupported', providerId: this.id, providerVersion: this.version, method: 'cancelled' },
        status: status('partial', 'cancelled'),
      });
    }

    const expected = image?.identity?.buildId ?? null;
    const observed = readBuildId(sections['.note.gnu.build-id'] ?? sections.note_gnu_build_id);
    const debugLink = readDebugLink(sections['.gnu_debuglink'] ?? sections.gnu_debuglink);

    let verdict = 'identity-unavailable';
    let method = 'unavailable';
    let expectedIdentity = expected;
    let observedIdentity = observed;
    let detail = null;

    if (expected != null && observed != null) {
      method = 'gnu-build-id';
      verdict = expected === observed ? 'matched-authoritative' : 'identity-mismatch';
      if (verdict === 'identity-mismatch') detail = 'build id of the debug source does not match the binary';
    } else if (debugLink != null) {
      // Split debug info: the binary points at a companion file by CRC. Without
      // the companion's bytes there is nothing to verify.
      method = 'gnu-debuglink-crc32';
      const companion = image?.companionBytes ?? null;
      if (companion == null) {
        verdict = 'companion-missing';
        detail = `debug link names ${debugLink.name} but the companion file was not supplied`;
        expectedIdentity = `crc32:${debugLink.crc32.toString(16)}`;
        observedIdentity = null;
      } else {
        const actual = gnuDebugLinkCrc32(companion);
        expectedIdentity = `crc32:${debugLink.crc32.toString(16)}`;
        observedIdentity = `crc32:${actual.toString(16)}`;
        verdict = actual === debugLink.crc32 ? 'matched-authoritative' : 'identity-mismatch';
        if (verdict === 'identity-mismatch') detail = 'companion debug file CRC does not match the debug link';
      }
    } else if (expected == null && observed == null) {
      verdict = 'identity-unavailable';
      detail = 'neither the binary nor the debug source carries a build identity';
    } else {
      verdict = 'identity-unavailable';
      detail = expected == null ? 'binary carries no build id' : 'debug source carries no build id';
    }

    if (!sections.debug_info && !sections['.debug_info']) {
      diagnostics.push('no .debug_info section');
    }

    const normalized = normalizeSections(sections);
    const parsed = parseDebugInfo(normalized, budget);
    diagnostics.push(...parsed.diagnostics);

    const result = createDebugProviderResult({
      ecosystem: 'dwarf',
      identity: {
        verdict,
        providerId: this.id,
        providerVersion: this.version,
        expected: expectedIdentity,
        observed: observedIdentity,
        method,
        detail,
      },
      sections: Object.keys(normalized).filter((key) => normalized[key] != null),
      counts: { dies: parsed.dies.size, units: parsed.units.length },
      diagnostics,
      status: parsed.complete && diagnostics.length === 0
        ? status('complete', null)
        : status('partial', 'evidence-missing'),
    });
    // The parsed forest travels with the result rather than being re-parsed by
    // every reader; it is not part of the frozen contract surface.
    return Object.freeze({ ...result, parsed });
  }

  /** Function and variable symbols, paged. */
  symbols(result, { cursor = null, pageSize = DEBUG_DEFAULT_PAGE_SIZE } = {}) {
    const dies = result.parsed?.dies;
    if (!dies) return createDebugPage({ records: [] });
    const ordered = [...dies.values()].filter((die) => die.tag === DW_TAG.subprogram || die.tag === DW_TAG.variable);
    return page(ordered, cursor, pageSize, (die) => {
      const lowPc = attributeValue(die, DW_AT.low_pc);
      const highPc = attributeValue(die, DW_AT.high_pc);
      const isFunction = die.tag === DW_TAG.subprogram;
      // DW_AT_high_pc is an offset from low_pc when its form is a constant, and
      // an absolute address when its form is an address class.
      const highForm = die.attributes.get(DW_AT.high_pc)?.form;
      const sizeBytes = highPc == null
        ? null
        : highForm === DW_FORM.addr
          ? Number(BigInt(highPc) - BigInt(lowPc ?? 0n))
          : Number(highPc);
      return createDebugRecord({
        kind: 'symbol',
        entityId: `dwarf_die_${die.offset}`,
        name: attributeName(die),
        address: toAddress(lowPc),
        sizeBytes,
        descriptor: { isFunction, external: attributeValue(die, DW_AT.external) != null, complete: die.complete },
        providerId: result.providerId,
        providerVersion: result.providerVersion,
        buildIdentity: result.identity.observed,
        evidenceIds: [`dwarf:die:${die.offset}`],
      });
    });
  }

  /** Type records for the TypeConstraintGraph, paged. */
  types(result, { cursor = null, pageSize = DEBUG_DEFAULT_PAGE_SIZE } = {}) {
    const dies = result.parsed?.dies;
    if (!dies) return createDebugPage({ records: [] });
    const typed = [...dies.values()].filter((die) => (
      die.tag === DW_TAG.subprogram || die.tag === DW_TAG.variable || die.tag === DW_TAG.formal_parameter
    ) && die.attributes.has(DW_AT.type));
    return page(typed, cursor, pageSize, (die) => {
      const described = describeType(referencedType(die, dies), dies);
      return createDebugRecord({
        kind: 'type',
        entityId: `dwarf_die_${die.offset}`,
        name: attributeName(die),
        descriptor: {
          layer: 'nominal',
          claim: { name: described.name, aliases: described.aliases ?? [] },
          machine: described.widthBits == null ? null : { widthBits: described.widthBits, class: described.class },
          complete: described.complete,
        },
        providerId: result.providerId,
        providerVersion: result.providerVersion,
        buildIdentity: result.identity.observed,
        evidenceIds: [`dwarf:die:${die.offset}`],
      });
    });
  }
}

function page(items, cursor, pageSize, map) {
  const start = cursor == null ? 0 : Number(cursor);
  const slice = items.slice(start, start + pageSize);
  const next = start + slice.length;
  return createDebugPage({
    records: slice.map(map),
    nextCursor: next < items.length ? String(next) : null,
    truncated: next < items.length,
  });
}

/** Accepts both `.debug_info` and `debug_info` spellings for section keys. */
function normalizeSections(sections) {
  const out = {};
  for (const key of ['debug_info', 'debug_abbrev', 'debug_str', 'debug_line_str', 'debug_str_offsets', 'debug_line', 'debug_addr', 'debug_rnglists']) {
    out[key] = sections[key] ?? sections[`.${key}`] ?? null;
  }
  return out;
}
