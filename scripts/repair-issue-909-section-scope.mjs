import fs from 'node:fs/promises';
async function read(path) { return fs.readFile(path, 'utf8'); }
async function write(path, content) { await fs.writeFile(path, content); }
async function replaceOnce(path, before, after) {
  const source = await read(path);
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`missing section-scope anchor in ${path}: ${before.slice(0,120)}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`ambiguous section-scope anchor in ${path}: ${before.slice(0,120)}`);
  await write(path, source.slice(0, first) + after + source.slice(first + before.length));
}

await replaceOnce('js/binary/elf.js',
`        return parsed ? { address:symbol.address, ...parsed } : null;
      })
      .filter(Boolean)
      .sort((left, right) => left.address < right.address ? -1 : left.address > right.address ? 1 : 0);
    image.metadata.riscvIsa = {
      file:riscvFileIsa,
      mappings,
      evidence:riscvFileIsa ? 'elf-attribute' : 'missing',
    };`,
`        return parsed ? { address:symbol.address, sectionIndex:symbol.sectionIndex, ...parsed } : null;
      })
      .filter(Boolean)
      .sort((left, right) => left.address < right.address ? -1 : left.address > right.address ? 1 : 0);
    const sections = rawSections
      .filter((section) => (section.flags & SHF_EXECINSTR) !== 0n && section.size > 0n)
      .map((section) => ({
        sectionIndex:section.index,
        start:h.type === ET_REL ? (section.syntheticAddr ?? 0n) : section.addr,
        end:(h.type === ET_REL ? (section.syntheticAddr ?? 0n) : section.addr) + section.size,
      }));
    image.metadata.riscvIsa = {
      file:riscvFileIsa,
      mappings,
      sections,
      evidence:riscvFileIsa ? 'elf-attribute' : 'missing',
    };`);

await replaceOnce('js/binary/riscv-isa.js',
`  let selected = null;
  const target = BigInt(address ?? 0);
  for (const mapping of metadata.mappings || []) {
    let mappingAddress;
    try { mappingAddress = BigInt(mapping.address); } catch { continue; }
    if (mappingAddress > target) break;
    selected = mapping;
  }
  if (selected?.kind === 'data') return Object.freeze({ code:false, exact:true, evidence:'mapping-symbol-data' });`,
`  let selected = null;
  const target = BigInt(address ?? 0);
  const containingSection = (metadata.sections || []).find((section) => {
    try { return target >= BigInt(section.start) && target < BigInt(section.end); }
    catch { return false; }
  }) || null;
  for (const mapping of metadata.mappings || []) {
    let mappingAddress;
    try { mappingAddress = BigInt(mapping.address); } catch { continue; }
    if (mappingAddress > target) break;
    if (containingSection && mapping.sectionIndex != null && Number(mapping.sectionIndex) !== Number(containingSection.sectionIndex)) continue;
    if (containingSection && mapping.sectionIndex == null) continue;
    if (!containingSection && Array.isArray(metadata.sections) && metadata.sections.length && mapping.sectionIndex != null) continue;
    selected = mapping;
  }
  if (selected?.kind === 'data') return Object.freeze({ code:false, exact:true, evidence:'mapping-symbol-data' });`);

const testPath = 'tests/phase6/generic-core/issues-907-909-910-913.test.mjs';
const source = await read(testPath);
const test = `\n\ntest('#909 mapping-symbol state never leaks across executable ELF sections', () => {\n  const file = { ...parseRiscvAttributes(attributesFor('rv64i2p1_m2p0')), evidence:'elf-attribute' };\n  const mapped = parseRiscvMappingSymbol('$xrv64i2p1_c2p0');\n  const metadata = {\n    file,\n    sections:[\n      { sectionIndex:1, start:0x1000n, end:0x1100n },\n      { sectionIndex:2, start:0x2000n, end:0x2100n },\n    ],\n    mappings:[{ address:0x1000n, sectionIndex:1, ...mapped }],\n  };\n  assert.equal(resolveRiscvIsaProfile(metadata, 0x1004n).compressedInstructions, true);\n  assert.equal(resolveRiscvIsaProfile(metadata, 0x2004n).compressedInstructions, false,\n    'section 2 must fall back to the file ISA rather than inheriting section 1 mapping state');\n});\n`;
if (!source.includes('mapping-symbol state never leaks across executable ELF sections')) await write(testPath, source + test);
console.log('RISC-V mapping symbols are section-scoped');
