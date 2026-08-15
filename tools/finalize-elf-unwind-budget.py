from pathlib import Path
p=Path('js/binary/elf-unwind.js')
s=p.read_text()
old="""      const initial = decodeEhValue(r, p, tableEnc, ctx, end); p = initial.next;
      const fde = decodeEhValue(r, p, tableEnc, ctx, end); p = fde.next;
      if (image.sectionAt(initial.value)?.perms.execute || image.segmentAt(initial.value)?.perms.execute) {
        if (budget && !budget.take({ objects:1, operations:1, estimatedHeapBytes:128 }, 'eh-frame-function')) break;
        image.functions.push(functionSeed(initial.value, { source: 'unwind', confidence: 0.985 }));
      }
      void fde;"""
new="""      const initial = decodeEhValue(r, p, tableEnc, ctx, end); p = initial.next;
      const fde = decodeEhValue(r, p, tableEnc, ctx, end); p = fde.next;
      if (initial.value == null || initial.value === 0n) continue;
      const codeSec = image.sectionAt(initial.value);
      const codeSeg = typeof image.segmentAt === 'function' ? image.segmentAt(initial.value) : null;
      if (codeSec?.perms?.execute || codeSeg?.perms?.execute) {
        if (budget && !budget.take({ objects:1, operations:1, estimatedHeapBytes:128 }, 'eh-frame-function')) break;
        image.functions.push(functionSeed(initial.value, { source: 'unwind', confidence: 0.985 }));
        added++;
      }
      void fde;"""
if old not in s: raise SystemExit('budgeted unwind loop anchor missing')
p.write_text(s.replace(old,new,1))
