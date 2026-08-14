import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, value) { fs.writeFileSync(path, value); }
function replace(path, before, after) {
  const src = read(path);
  const count = src.split(before).length - 1;
  if (count !== 1) throw new Error(`${path}: expected one match, got ${count}\n${before}`);
  write(path, src.replace(before, after));
}

const dynamic = 'js/binary/elf-dynamic.js';

replace(dynamic,
`import { functionSeed } from './model.js';`,
`import { functionSeed } from './model.js';\nimport { collectAndroidPackedRelocations, collectRelrRelocations, parseDynamicSymbolVersions } from './elf-extended.js';`);

replace(dynamic,
`  const relocs = collectDynamicRelocations(r, tags, image, bits);\n  let symbolCount = 0;\n  if (symtab != null && symentValid) {\n    symbolCount = symbolCountFromHash(r, one(DT_HASH), image) ||\n      symbolCountFromGnuHash(r, one(DT_GNU_HASH), image, bits) ||\n      symbolCountFromRelocations(relocs) ||\n      symbolCountFromLayout(symtab, strtab, syment);\n  }\n\n  let symbols = [];\n  if (opts.symbols !== false && symtab != null && symbolCount > 0) {\n    symbols = parseDynamicSymbols(r, image, bits, symtab, syment, symbolCount, stringAt);\n  } else if (symtab != null && symbolCount > 0) {\n    symbols = dynamicSymbolsFromImage(image);\n  }\n\n  if (opts.relocations !== false) attachDynamicRelocations(image, relocs, symbols);`,
`  const relocs = collectDynamicRelocations(r, tags, image, bits);\n  relocs.push(...collectRelrRelocations(r, tags, image, bits));\n  relocs.push(...collectAndroidPackedRelocations(r, tags, image, bits));\n  let symbolCount = 0;\n  let symbolCountSource = 'none';\n  if (symtab != null && symentValid) {\n    symbolCount = symbolCountFromHash(r, one(DT_HASH), image);\n    if (symbolCount) symbolCountSource = 'sysv-hash';\n    if (!symbolCount) { symbolCount = symbolCountFromGnuHash(r, one(DT_GNU_HASH), image, bits); if (symbolCount) symbolCountSource = 'gnu-hash'; }\n    if (!symbolCount) { symbolCount = symbolCountFromRelocations(relocs); if (symbolCount) symbolCountSource = 'relocations'; }\n    if (!symbolCount) {\n      symbolCount = symbolCountFromLayout(symtab, strtab, syment, image, r);\n      if (symbolCount) { symbolCountSource = 'layout-heuristic'; markExtendedPartial(image, 'dynamic symbol count was inferred from bounded SYMTAB/STRTAB layout'); }\n    }\n  }\n\n  const versions = parseDynamicSymbolVersions(r, tags, image, symbolCount, stringAt);\n  let symbols = [];\n  if (opts.symbols !== false && symtab != null && symbolCount > 0) {\n    symbols = parseDynamicSymbols(r, image, bits, symtab, syment, symbolCount, stringAt, versions);\n  } else if (symtab != null && symbolCount > 0) {\n    symbols = dynamicSymbolsFromImage(image);\n  }\n\n  applyVersionMetadata(image, versions);\n  if (opts.relocations !== false) attachDynamicRelocations(image, relocs, symbols);`);

replace(dynamic,
`    symbols: symbolCount,\n    relocations: relocs.length,`,
`    symbols: symbolCount,\n    symbolCountSource,\n    relocations: relocs.length,`);

replace(dynamic,
`function parseDynamicSymbols(r, image, bits, symtabVa, syment, count, stringAt) {`,
`function parseDynamicSymbols(r, image, bits, symtabVa, syment, count, stringAt, versions = new Map()) {`);

replace(dynamic,
`    const sym = { name, address: value, size, kind, binding, defined, sectionIndex: shndx, visibility: other & 3, source: 'PT_DYNAMIC', index: i, tableIndex: -1 };\n    out.push(sym);\n    if (!name) continue;\n    image.symbols.push(sym);\n    if (!defined && (bind === 1 || bind === 2)) image.imports.push({ name, library: null, ordinal: null, weak: bind === 2, source: 'PT_DYNAMIC', sites: [] });\n    if (defined && (bind === 1 || bind === 2) && sym.visibility !== 2) image.exports.push({ name, address: value, kind, source: 'PT_DYNAMIC' });`,
`    const ver = versions.get(i) || null;\n    const sym = { name, address: value, size, kind, binding, defined, sectionIndex: shndx, visibility: other & 3, source: 'PT_DYNAMIC', index: i, tableIndex: -1, versionIndex: ver?.index ?? null, version: ver?.name ?? null, versionHidden: ver?.hidden ?? false, versionLibrary: ver?.library ?? null };\n    out.push(sym);\n    if (!name) continue;\n    image.symbols.push(sym);\n    if (!defined && (bind === 1 || bind === 2)) image.imports.push({ name, library: null, ordinal: null, weak: bind === 2, version: ver?.name ?? null, versionLibrary: ver?.library ?? null, versionIndex: ver?.index ?? null, symbolIndex: i, source: 'PT_DYNAMIC', sites: [] });\n    if (defined && (bind === 1 || bind === 2) && (sym.visibility === 0 || sym.visibility === 3)) image.exports.push({ name, address: value, kind, version: ver?.name ?? null, versionIndex: ver?.index ?? null, symbolIndex: i, source: 'PT_DYNAMIC' });`);

replace(dynamic,
`function collectDynamicRelocations(r, tags, image, bits) {`,
`function applyVersionMetadata(image, versions) {\n  if (!versions?.size) return;\n  for (const sym of image.symbols) {\n    if (sym.source !== 'dynsym' && sym.source !== 'PT_DYNAMIC') continue;\n    const ver = versions.get(sym.index);\n    if (!ver) continue;\n    sym.versionIndex = ver.index; sym.version = ver.name; sym.versionHidden = ver.hidden; sym.versionLibrary = ver.library;\n    if (!sym.defined && sym.name) {\n      const imp = image.imports.find((item) => item.name === sym.name && item.version == null && (item.symbolIndex == null || item.symbolIndex === sym.index));\n      if (imp) { imp.version = ver.name; imp.versionLibrary = ver.library; imp.versionIndex = ver.index; imp.symbolIndex ??= sym.index; }\n    } else if (sym.defined && sym.name) {\n      const ex = image.exports.find((item) => item.name === sym.name && item.address === sym.address && item.version == null && (item.symbolIndex == null || item.symbolIndex === sym.index));\n      if (ex) { ex.version = ver.name; ex.versionIndex = ver.index; ex.symbolIndex ??= sym.index; }\n    }\n  }\n}\n\nfunction collectDynamicRelocations(r, tags, image, bits) {`);

replace(dynamic,
`  const importByName = new Map(image.imports.filter((x) => x.name).map((x) => [x.name, x]));\n  for (const rel of relocs) {`,
`  const importKey = (name, version, library) => [name || '', version || '', library || ''].join('\\0');\n  const importByName = new Map(image.imports.filter((x) => x.name).map((x) => [importKey(x.name, x.version, x.versionLibrary), x]));\n  for (const rel of relocs) {`);
replace(dynamic,
`      let imp = importByName.get(sym.name);\n      if (!imp) {\n        imp = { name: sym.name, library: null, ordinal: null, weak: sym.binding === 'weak', source: 'PT_DYNAMIC', sites: [] };\n        image.imports.push(imp); importByName.set(sym.name, imp);\n      }`,
`      const key = importKey(sym.name, sym.version, sym.versionLibrary);\n      let imp = importByName.get(key);\n      if (!imp) {\n        imp = { name: sym.name, library: null, ordinal: null, weak: sym.binding === 'weak', version: sym.version ?? null, versionLibrary: sym.versionLibrary ?? null, versionIndex: sym.versionIndex ?? null, symbolIndex: sym.index, source: 'PT_DYNAMIC', sites: [] };\n        image.imports.push(imp); importByName.set(key, imp);\n      }`);

replace(dynamic,
`  let max = symOffset;\n  for (let i = 0; i < nbuckets; i++) {`,
`  let max = symOffset;\n  let remainingSteps = Math.min(10_000_000, Math.max(4096, nbuckets * 64));\n  for (let i = 0; i < nbuckets; i++) {`);
replace(dynamic,
`    for (let guard = 0; guard < 10_000_000 && p + 4 <= r.length; guard++, idx++, p += 4) {\n      const chain = r.u32(p);`,
`    for (; p + 4 <= r.length; idx++, p += 4) {\n      if (--remainingSteps < 0) { markExtendedPartial(image, 'GNU hash chain traversal exceeded the global budget'); return 0; }\n      const chain = r.u32(p);`);

replace(dynamic,
`function symbolCountFromLayout(symtab, strtab, syment) {\n  if (strtab == null || strtab <= symtab || syment <= 0n) return 0;\n  const n = (strtab - symtab) / syment;\n  return n > 0n && n <= 10_000_000n ? Number(n) : 0;\n}\n\nfunction markDynamicPartial`,
`function symbolCountFromLayout(symtab, strtab, syment, image, r) {\n  if (strtab == null || strtab <= symtab || syment <= 0n) return 0;\n  const delta = strtab - symtab;\n  if (delta % syment !== 0n) return 0;\n  const n = delta / syment;\n  if (n <= 0n || n > 1_000_000n) return 0;\n  const symOff = vaToOffset(image, symtab), strOff = vaToOffset(image, strtab);\n  if (symOff == null || strOff == null || strOff <= symOff || strOff > r.length) return 0;\n  if (BigInt(strOff - symOff) !== delta) return 0;\n  return Number(n);\n}\n\nfunction markExtendedPartial(image, message) {\n  image.metadata.programDynamicPartial = true;\n  const list = image.metadata.programDynamicDiagnostics ||= [];\n  if (!list.includes(message)) list.push(message);\n  image.warnings.push('PT_DYNAMIC: ' + message);\n}\n\nfunction markDynamicPartial`);

const elf = 'js/binary/elf.js';
replace(elf,
`    if (!defined && (bind === 1 || bind === 2)) image.imports.push({ name, library: null, ordinal: null, weak: bind === 2, source: sym.source, sites: [] });\n    if (defined && (bind === 1 || bind === 2) && (sym.visibility === 0 || sym.visibility === 3)) image.exports.push({ name, address: value, kind, source: sym.source });`,
`    if (!defined && (bind === 1 || bind === 2)) image.imports.push({ name, library: null, ordinal: null, weak: bind === 2, symbolIndex: i, tableIndex: table.index, source: sym.source, sites: [] });\n    if (defined && (bind === 1 || bind === 2) && (sym.visibility === 0 || sym.visibility === 3)) image.exports.push({ name, address: value, kind, symbolIndex: i, tableIndex: table.index, source: sym.source });`);

fs.rmSync('tools/integrate-elf-74-97.mjs');
fs.rmSync('.github/workflows/integrate-elf-74-97.yml');
