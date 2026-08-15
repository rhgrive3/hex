import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ByteView, BinaryReadError } from '../js/binary/reader.js';
import { parseClassicBindings, parseExportTrie } from '../js/binary/macho-dyld.js';
import { parseEhFrameHeader } from '../js/binary/elf-unwind.js';

// Common decoder: the same backing bytes are valid unbounded, but invalid when
// the logical owner ends before the terminating byte.
{
  const r = new ByteView(new Uint8Array([0x80, 0x01, 0x7f]));
  assert.equal(r.uleb(0).value, 128n);
  assert.throws(() => r.uleb(0, 10, 1), (e) => e instanceof BinaryReadError && /bounded substream/.test(e.message));
  assert.equal(r.sleb(2).value, -1n);
  const s = new ByteView(new Uint8Array([0x80, 0x7f]));
  assert.throws(() => s.sleb(0, 10, 1), (e) => e instanceof BinaryReadError && /bounded substream/.test(e.message));
}

// Mach-O classic bind stream: byte 2 is adjacent backing data, not part of the
// declared 2-byte bind stream. It must not terminate the split ULEB.
{
  const r = new ByteView(new Uint8Array([0x20, 0x80, 0x01, 0x00]));
  const image = { bits:64, metadata:{}, warnings:[], imports:[], libraries:[], addressToOffset:()=>null };
  const status = parseClassicBindings(r, { offset:0, size:2 }, image, [], 'bind');
  assert.equal(status.complete, false);
  assert.equal(status.decodedBinds, 0);
  assert.ok(image.warnings.some((x) => /bounded stream operand is truncated/.test(x)));
}

// Mach-O export trie: terminalSize says only the flags byte belongs to the
// terminal. The next backing byte cannot be stolen as the missing address ULEB.
{
  const r = new ByteView(new Uint8Array([0x01, 0x00, 0x00]));
  const image = {
    imageBase:0x1000n, metadata:{}, warnings:[], exports:[], functions:[],
    sectionAt:()=>({ perms:{ execute:true } }),
  };
  const status = parseExportTrie(r, { offset:0, size:2 }, image);
  assert.equal(status.complete, false);
  assert.equal(image.exports.length, 0);
  assert.equal(image.functions.length, 0);
}

// ELF .eh_frame_hdr: the count ULEB is split at the section boundary. The byte
// immediately after the section must not turn the truncated field into count=0.
{
  const r = new ByteView(new Uint8Array([1, 0xff, 0x01, 0x01, 0x80, 0x00]));
  const image = {
    segments:[], functions:[], metadata:{}, warnings:[],
    sectionAt:()=>null, addressToOffset:()=>null,
  };
  parseEhFrameHeader(r, { offset:0n, size:5n, addr:0n }, image, 64);
  assert.equal(image.metadata.ehFrameHeader, undefined);
  assert.equal(image.functions.length, 0);
  assert.ok(image.warnings.some((x) => /eh_frame_hdr/.test(x) && /bounded substream/.test(x)));
}

// LC_FUNCTION_STARTS is private to macho.js, so guard the product source path
// in addition to exercising the shared decoder above.
{
  const macho = fs.readFileSync(new URL('../js/binary/macho.js', import.meta.url), 'utf8');
  assert.match(macho, /LC_FUNCTION_STARTS:[^\n]*\$\{e\.message\}/);
  assert.match(macho, /r\.uleb\(p,\s*10,\s*end\)/);
  const dyld = fs.readFileSync(new URL('../js/binary/macho-dyld.js', import.meta.url), 'utf8');
  assert.match(dyld, /r\.uleb\(p,\s*10,\s*terminalEnd\)/);
  const unwind = fs.readFileSync(new URL('../js/binary/elf-unwind.js', import.meta.url), 'utf8');
  assert.match(unwind, /decodeEhValue\(r, p, tableEnc, ctx, end\)/);
}

console.log('issue #572 bounded LEB regressions: PASS');
