import assert from 'node:assert/strict';
import './issues-961-967.mjs';
import './issues-969-971.mjs';
import { parseMachO } from '../js/binary/macho.js';
import { parsePE } from '../js/binary/pe.js';

function machoWithFirstCommand(cmd, cmdsize) {
  const secondSize = 24;
  const bytes = new Uint8Array(32 + cmdsize + secondSize);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, 0xfeedfacf, true);       // MH_MAGIC_64
  dv.setInt32(4, 0x0100000c, true);        // CPU_TYPE_ARM64
  dv.setInt32(8, 0, true);
  dv.setUint32(12, 2, true);               // MH_EXECUTE
  dv.setUint32(16, 2, true);               // ncmds
  dv.setUint32(20, cmdsize + secondSize, true);
  dv.setUint32(24, 0, true); dv.setUint32(28, 0, true);
  let p = 32;
  dv.setUint32(p, cmd, true); dv.setUint32(p + 4, cmdsize, true);
  // Adjacent bytes deliberately look usable to an over-reading parser.
  p += cmdsize;
  dv.setUint32(p, 0x77777777, true); dv.setUint32(p + 4, secondSize, true);
  dv.setUint32(p + 8, 0x12345678, true); dv.setUint32(p + 12, 1, true);
  dv.setUint32(p + 16, 0x20, true); dv.setUint32(p + 20, 8, true);
  return bytes;
}

// #463: command-specific fields are never read across cmdsize into the next LC.
{
  const symtab = parseMachO(machoWithFirstCommand(0x2, 8)); // LC_SYMTAB needs 24
  assert.ok(symtab.warnings.some((w) => /invalid LC_SYMTAB size 8/.test(w)), symtab.warnings.join('\n'));
  assert.equal(symtab.symbols.length, 0);
  assert.equal(symtab.exports.length, 0);

  const version = parseMachO(machoWithFirstCommand(0x25, 8)); // LC_VERSION_MIN_IPHONEOS needs 16
  assert.ok(version.warnings.some((w) => /invalid LC_VERSION_MIN size 8/.test(w)), version.warnings.join('\n'));
  assert.equal(version.metadata.buildVersion, undefined);

  const dylib = parseMachO(machoWithFirstCommand(0x0c, 8)); // LC_LOAD_DYLIB needs 24
  assert.ok(dylib.warnings.some((w) => /invalid dylib command size 8/.test(w)), dylib.warnings.join('\n'));
  assert.equal(dylib.libraries.length, 0);
}

function peFixture({ entryRva = 0x1000, machine = 0x8664, executable = true, virtualSize = 0x100, rawSize = 0x100 } = {}) {
  const bytes = new Uint8Array(0x400);
  const dv = new DataView(bytes.buffer);
  dv.setUint16(0, 0x5a4d, true);            // MZ
  dv.setUint32(0x3c, 0x80, true);
  const pe = 0x80;
  dv.setUint32(pe, 0x00004550, true);        // PE\0\0
  const coff = pe + 4;
  dv.setUint16(coff, machine, true);
  dv.setUint16(coff + 2, 1, true);
  dv.setUint16(coff + 16, 112, true);        // PE32+ minimum optional header
  const opt = coff + 20;
  dv.setUint16(opt, 0x20b, true);
  dv.setUint32(opt + 16, entryRva, true);
  dv.setBigUint64(opt + 24, 0x140000000n, true);
  dv.setUint32(opt + 32, 0x1000, true);
  dv.setUint32(opt + 36, 0x200, true);
  dv.setUint32(opt + 56, 0x3000, true);
  dv.setUint32(opt + 60, 0x200, true);
  dv.setUint16(opt + 68, 3, true);
  dv.setUint32(opt + 108, 0, true);
  const sec = opt + 112;
  new TextEncoder().encodeInto('.text', bytes.subarray(sec, sec + 8));
  dv.setUint32(sec + 8, virtualSize, true);
  dv.setUint32(sec + 12, 0x1000, true);
  dv.setUint32(sec + 16, rawSize, true);
  dv.setUint32(sec + 20, 0x200, true);
  const flags = 0x40000000 | (executable ? 0x20000000 : 0) | (executable ? 0 : 0x80000000);
  dv.setUint32(sec + 36, flags >>> 0, true);
  return bytes;
}

function entrySeeds(image) { return image.functions.filter((f) => f.source === 'entrypoint'); }
function rejected(image, fragment) {
  assert.equal(entrySeeds(image).length, 0, 'invalid entrypoint must not become a function seed');
  assert.equal(image.metadata.entrypointValid, false);
  assert.ok(image.warnings.some((w) => w.includes(fragment)), image.warnings.join('\n'));
}

// #461: high-confidence entrypoint seeds require mapped executable file-backed bytes.
{
  const valid = parsePE(peFixture());
  assert.equal(entrySeeds(valid).length, 1);
  assert.equal(valid.metadata.entrypointValid, true);

  rejected(parsePE(peFixture({ executable: false })), 'section is not executable');
  rejected(parsePE(peFixture({ entryRva: 0x100 })), 'not mapped by a section');
  rejected(parsePE(peFixture({ entryRva: 0x1800 })), 'not mapped by a section');
  rejected(parsePE(peFixture({ entryRva: 0x1080, virtualSize: 0x100, rawSize: 0x40 })), 'no file-backed instruction byte');
  rejected(parsePE(peFixture({ entryRva: 0x4000 })), 'outside SizeOfImage');
  rejected(parsePE(peFixture({ entryRva: 0x1002, machine: 0xaa64 })), 'not 4-byte aligned');
}

console.log('issues #461/#463 binary trust-boundary regressions PASS');