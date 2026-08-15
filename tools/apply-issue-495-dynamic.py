from pathlib import Path

p=Path('js/binary/elf-dynamic.js')
text=p.read_text()
if "./relocation-budget.js" not in text:
    text=text.replace("import { functionSeed } from './model.js';\n", "import { functionSeed } from './model.js';\nimport { createRelocationBudget } from './relocation-budget.js';\n", 1)
old="""  const relocs = collectDynamicRelocations(r, tags, image, bits);\n  relocs.push(...collectRelrRelocations(r, tags, image, bits));\n  relocs.push(...collectAndroidPackedRelocations(r, tags, image, bits));\n"""
new="""  const relocationBudget = createRelocationBudget({\n    onLimit(message) { markDynamicPartial(image, `relocation decode budget exceeded: ${message}`); },\n  });\n  const relocs = collectDynamicRelocations(r, tags, image, bits, relocationBudget);\n  if (!relocationBudget.stopped) collectRelrRelocations(r, tags, image, bits, { budget: relocationBudget, out: relocs });\n  if (!relocationBudget.stopped) collectAndroidPackedRelocations(r, tags, image, bits, { budget: relocationBudget, out: relocs });\n  image.metadata.programDynamicRelocationBudget = relocationBudget.snapshot(relocs.length);\n"""
if new not in text:
    if old not in text: raise SystemExit('parseProgramDynamic relocation anchor not found')
    text=text.replace(old,new,1)
start_marker='function collectDynamicRelocations(r, tags, image, bits) {'
if start_marker in text:
    start=text.index(start_marker)
    end=text.index('\nfunction attachDynamicRelocations(',start)
    replacement=r'''function collectDynamicRelocations(r, tags, image, bits, budget) {
  const out = [];
  const seen = new Set();
  const one = (tag) => tags.get(tag)?.[0] ?? null;
  const addTable = (va, size, ent, rela, source) => {
    if (budget.stopped || va == null || size == null || size <= 0n) return;
    const off = vaToOffset(image, va);
    const n = toSafeNumber(size);
    const minimum = BigInt(bits === 64 ? (rela ? 24 : 16) : (rela ? 12 : 8));
    const requested = ent ?? minimum;
    if (requested < minimum) { markDynamicPartial(image, `${source} entry size ${requested} is smaller than ${minimum}`); return; }
    const e = toSafeNumber(requested);
    if (off == null || n == null || e == null || e <= 0 || off + n > r.length) return;
    if (!budget.claimInput(n, source)) return;
    const count = Math.floor(n / e);
    for (let i = 0; i < count && !budget.stopped; i++) {
      if (!budget.step()) break;
      const q = off + i * e;
      let address, addend = null, symIndex, type;
      if (bits === 64) {
        address = r.u64(q); const info = r.u64(q + 8); symIndex = Number(info >> 32n); type = Number(info & 0xffffffffn);
        if (rela) addend = r.i64(q + 16);
      } else {
        address = BigInt(r.u32(q)); const raw = r.u32(q + 4); symIndex = raw >>> 8; type = raw & 0xff;
        if (rela) addend = BigInt(r.i32(q + 8));
      }
      const key = `${address}:${symIndex}:${type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!budget.push(out, { address, symIndex, type, addend, source }, source)) break;
    }
  };

  addTable(one(DT_RELA), one(DT_RELASZ), one(DT_RELAENT), true, 'PT_DYNAMIC-RELA');
  addTable(one(DT_REL), one(DT_RELSZ), one(DT_RELENT), false, 'PT_DYNAMIC-REL');
  const jmprel = one(DT_JMPREL), pltsz = one(DT_PLTRELSZ), pltrel = one(DT_PLTREL);
  if (!budget.stopped && jmprel != null && pltsz != null) {
    if (pltrel === DT_RELA) addTable(jmprel, pltsz, one(DT_RELAENT), true, 'PT_DYNAMIC-JMPREL-RELA');
    else if (pltrel === DT_REL) addTable(jmprel, pltsz, one(DT_RELENT), false, 'PT_DYNAMIC-JMPREL-REL');
    else markDynamicPartial(image, `DT_PLTREL has unsupported value ${pltrel == null ? '<missing>' : pltrel}; JMPREL was not decoded`);
  }
  return out;
}
'''
    text=text[:start]+replacement+text[end:]
p.write_text(text)
