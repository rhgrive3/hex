from pathlib import Path


def once(text, old, new, label):
    if new in text:
        return text
    if old not in text:
        raise SystemExit(f'missing patch anchor: {label}')
    return text.replace(old, new, 1)

# #463: every known load command must stay inside its ABI struct boundary.
p = Path('js/binary/macho.js')
s = p.read_text()
s = once(s,
"""      if (cmd === LC_SEGMENT_64 && bits === 64) parseSegment64(r, p, cmdsize, image, segmentOrder);
      else if (cmd === LC_SEGMENT && bits === 32) parseSegment32(r, p, cmdsize, image, segmentOrder);
      else if (cmd === LC_SYMTAB) symtabs.push({ symoff: r.u32(p + 8), nsyms: r.u32(p + 12), stroff: r.u32(p + 16), strsize: r.u32(p + 20) });
      else if (DYLIB_COMMANDS.has(cmd) || cmd === LC_ID_DYLIB) parseDylib(r, p, cmdsize, image, cmd === LC_ID_DYLIB);""",
"""      if (cmd === LC_SEGMENT_64 && bits === 64) parseSegment64(r, p, cmdsize, image, segmentOrder);
      else if (cmd === LC_SEGMENT && bits === 32) parseSegment32(r, p, cmdsize, image, segmentOrder);
      else if (cmd === LC_SYMTAB) {
        if (cmdsize < 24) throw new Error(`invalid LC_SYMTAB size ${cmdsize}`);
        symtabs.push({ symoff: r.u32(p + 8), nsyms: r.u32(p + 12), stroff: r.u32(p + 16), strsize: r.u32(p + 20) });
      }
      else if (DYLIB_COMMANDS.has(cmd) || cmd === LC_ID_DYLIB) {
        if (cmdsize < 24) throw new Error(`invalid dylib command size ${cmdsize}`);
        parseDylib(r, p, cmdsize, image, cmd === LC_ID_DYLIB);
      }""", 'Mach-O symtab/dylib minimum')
s = once(s,
"""      else if (cmd === LC_VERSION_MIN_MACOSX || cmd === LC_VERSION_MIN_IPHONEOS || cmd === LC_VERSION_MIN_TVOS || cmd === LC_VERSION_MIN_WATCHOS) parseLegacyVersionMin(r, p, cmd, image);""",
"""      else if (cmd === LC_VERSION_MIN_MACOSX || cmd === LC_VERSION_MIN_IPHONEOS || cmd === LC_VERSION_MIN_TVOS || cmd === LC_VERSION_MIN_WATCHOS) {
        if (cmdsize < 16) throw new Error(`invalid LC_VERSION_MIN size ${cmdsize}`);
        parseLegacyVersionMin(r, p, cmd, image);
      }""", 'Mach-O version minimum')
p.write_text(s)

# #461: a PE entrypoint is a high-confidence function seed only when it points to
# file-backed executable bytes in a mapped section and satisfies architecture alignment.
p = Path('js/binary/pe.js')
s = p.read_text()
s = once(s,
"""  if (entryRva) image.functions.push(functionSeed(image.entrypoint, { source: 'entrypoint', confidence: 0.9 }));
  parseCoffSymbols(r, ptrSymbols, numberOfSymbols, image);""",
"""  if (entryRva) seedValidatedEntrypoint(image, entryRva, sizeOfImage, machine);
  parseCoffSymbols(r, ptrSymbols, numberOfSymbols, image);""", 'PE entrypoint seed call')
insert_before = "\nexport function parsePE(input) {"
helper = r'''
function seedValidatedEntrypoint(image, entryRva, sizeOfImage, machine) {
  const address = image.imageBase + BigInt(entryRva);
  const reject = (reason) => {
    image.warnings.push(`PE entrypoint 0x${entryRva.toString(16)} rejected: ${reason}`);
    image.metadata.entrypointValid = false;
    image.metadata.entrypointDiagnostic = reason;
  };
  if (entryRva >= sizeOfImage) { reject('RVA is outside SizeOfImage'); return; }
  const segment = image.segments.find((s) => s.source === 'PE-section' &&
    address >= s.address && address < s.address + s.size);
  if (!segment) { reject('RVA is not mapped by a section'); return; }
  if (!segment.perms?.execute) { reject('section is not executable'); return; }
  const offset = address - segment.address;
  if (offset < 0n || offset >= segment.fileSize) { reject('entrypoint has no file-backed instruction byte'); return; }
  const alignment = machine === 0xaa64 || machine === 0x01c0 || machine === 0x01c4 ? 4n : 1n;
  if (address % alignment !== 0n) { reject(`address is not ${alignment}-byte aligned`); return; }
  image.metadata.entrypointValid = true;
  image.metadata.entrypointDiagnostic = null;
  image.functions.push(functionSeed(address, { source: 'entrypoint', confidence: 0.9 }));
}
'''
if 'function seedValidatedEntrypoint' not in s:
    if insert_before not in s:
        raise SystemExit('PE helper insertion anchor missing')
    s = s.replace(insert_before, helper + insert_before, 1)
p.write_text(s)

# Keep focused hardening in the binary regression graph.
p = Path('package.json')
s = p.read_text()
needle = '"binary:test": "'
if 'node tests/issues-461-463-binary.mjs' not in s:
    at = s.index(needle) + len(needle)
    s = s[:at] + 'node tests/issues-461-463-binary.mjs && ' + s[at:]
p.write_text(s)
