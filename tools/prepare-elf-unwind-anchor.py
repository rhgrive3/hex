from pathlib import Path
p=Path('js/binary/elf-unwind.js')
s=p.read_text()
old="""    let added = 0;
    for (let i = 0; i < count && p < end; i++) {
      const initial = decodeEhValue(r, p, tableEnc, ctx, end); p = initial.next;
      const fde = decodeEhValue(r, p, tableEnc, ctx, end); p = fde.next;
      if (initial.value == null || initial.value === 0n) continue;
      const codeSec = image.sectionAt(initial.value);
      if (codeSec && codeSec.perms.execute) {
        image.functions.push(functionSeed(initial.value, { source: 'unwind', confidence: 0.985 }));
        added++;
      }
      void fde;
    }"""
new="""    let added = 0;
    for (let i = 0; i < count && p < end; i++) {
      const initial = decodeEhValue(r, p, tableEnc, ctx, end); p = initial.next;
      const fde = decodeEhValue(r, p, tableEnc, ctx, end); p = fde.next;
      if (image.sectionAt(initial.value)?.perms.execute || image.segmentAt(initial.value)?.perms.execute) {
        image.functions.push(functionSeed(initial.value, { source: 'unwind', confidence: 0.985 }));
      }
      void fde;
    }"""
if old not in s: raise SystemExit('current #572 unwind loop anchor missing')
p.write_text(s.replace(old,new,1))
