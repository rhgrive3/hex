from pathlib import Path

p = Path('js/worker-legacy.js')
text = p.read_text()

def once(old, new, label):
    global text
    if new in text:
        return
    if old not in text:
        raise SystemExit(f'{label} anchor not found')
    text = text.replace(old, new, 1)

once("importScripts('./macho.js', './words.js', '../capstone.js');",
     "importScripts('./macho.js', './words.js', './address-provenance.js', '../capstone.js');",
     'worker imports')

once("""  let funcs = new BigUint64Array(0);
  let functionStartsExact = false;
""", """  let funcs = new BigUint64Array(0);
  let functionStartsExact = false;
  // Worker-private exact boundaries for CFG-aware address provenance. The
  // typed array returned to the main thread is still built below.
  slice.functionStarts = [];
""", 'function starts init')

once("""      const list = MachO.parseFunctionStarts(buf, info.textVM);
      funcs = new BigUint64Array(list.length);
      for (let i = 0; i < list.length; i++) funcs[i] = list[i];
      functionStartsExact = list.length > 0;
    } catch { funcs = new BigUint64Array(0); }
""", """      const list = MachO.parseFunctionStarts(buf, info.textVM);
      slice.functionStarts = list;
      funcs = new BigUint64Array(list.length);
      for (let i = 0; i < list.length; i++) funcs[i] = list[i];
      functionStartsExact = list.length > 0;
    } catch { slice.functionStarts = []; funcs = new BigUint64Array(0); }
""", 'function starts cache')

anchor = """/* ── プログラム全体の索引（1 パスで作る） ───────────────────
"""
helper = """function functionStartsForRegion(region) {
  if (!region) return [];
  for (const slice of slices || []) {
    if (!slice || !slice.functionStarts || !slice.functionStarts.length) continue;
    if ((slice.regions || []).some((r) => r && r.id === region.id)) return slice.functionStarts;
  }
  return [];
}

/* ── プログラム全体の索引（1 パスで作る） ───────────────────
"""
if 'function functionStartsForRegion(region)' not in text:
    if anchor not in text: raise SystemExit('program index section anchor not found')
    text = text.replace(anchor, helper, 1)

once("""  // レジスタごとに「直近の adrp が作ったページ」を覚える。ブロックをまたいでも続く。
  const pageOf = new Array(32).fill(null);
  const pageAt = new Array(32).fill(-1);
  let index = 0;
""", """  const provenance = AddressProvenance.create({
    words: Words,
    pairWindow: PAIR_WINDOW,
    functionStarts: functionStartsForRegion(region),
    rangeStart: region.vmAddr,
    rangeEnd: region.vmAddr + region.size,
  });
  let index = 0;
""", 'scanProgram state')

old = """      const kind = Words.classifyWord(w);
      if (index < kinds.length) kinds[index] = kind;

      if (kind === Words.KIND.CALL) {
        const t = Words.branchImm26(w, pc);
        if (t != null) {
          if (nCalls === callFrom.length && !growCalls()) callsCapped = true;
          if (nCalls < callFrom.length) { callFrom[nCalls] = pc; callTo[nCalls] = t; nCalls++; }
        }
        continue;
      }

      // adrp / adr — アドレスの土台
      const rel = Words.pcRelTarget(w, pc);
      if (rel) {
        pageOf[rel.reg] = rel.value;
        pageAt[rel.reg] = index;
        if (!rel.page) addRef(pc, rel.value, 0);
        continue;
      }

      // adrp の続き: add で場所そのもの、ldr/str でその中身
      const pair = Words.pairedOffset(w);
      if (pair && pageOf[pair.rn] != null && index - pageAt[pair.rn] <= PAIR_WINDOW) {
        const full = pageOf[pair.rn] + pair.imm;
        addRef(pc, full, pair.load ? 1 : pair.store ? 2 : 0);
        // add の結果は別レジスタに移ることがあるので、そのまま引き継ぐ
        if (!pair.load && !pair.store) { pageOf[pair.rd] = full; pageAt[pair.rd] = index; }
        else if (pair.rd !== pair.rn) { pageOf[pair.rd] = null; pageAt[pair.rd] = -1; }
        continue;
      }

      // ldr literal — すぐ近くに置かれた定数
      if (kind === Words.KIND.LITERAL) {
        const t = Words.literalTarget(w, pc);
        if (t != null) addRef(pc, t, 1);
        continue;
      }

      /*
       * 書き換えられたレジスタのページ情報は捨てる（古い前提を持ち越さない）。
       *
       * 「下位 5 ビット = 書き込み先」は、書き込む命令にしか当てはまらない。
       * `str x8, [x9]` の下位 5 ビットは x8 だが、x8 は読まれるだけで壊れない。
       * ここで一律に捨てていたので、adrp で組んだアドレスを一度どこかへ保存すると、
       * その後の `add x8, x8, #off` が組にならず、参照が丸ごと落ちていた。
       */
      if (WRITES_LOW_REG[kind]) {
        const d = w & 0x1f;
        if (pageAt[d] >= 0 && pageAt[d] !== index) { pageOf[d] = null; pageAt[d] = -1; }
      }
"""
new = """      provenance.enter(pc);
      const kind = Words.classifyWord(w);
      if (index < kinds.length) kinds[index] = kind;

      if (kind === Words.KIND.CALL || kind === Words.KIND.INDCALL) {
        if (kind === Words.KIND.CALL) {
          const t = Words.branchImm26(w, pc);
          if (t != null) {
            if (nCalls === callFrom.length && !growCalls()) callsCapped = true;
            if (nCalls < callFrom.length) { callFrom[nCalls] = pc; callTo[nCalls] = t; nCalls++; }
          }
        }
        provenance.control(w, pc, kind);
        continue;
      }
      if (kind === Words.KIND.CONDBR || kind === Words.KIND.BRANCH ||
          kind === Words.KIND.RET || kind === Words.KIND.TRAP) {
        provenance.control(w, pc, kind);
        continue;
      }

      // adrp / adr — アドレスの土台
      const rel = Words.pcRelTarget(w, pc);
      if (rel) {
        provenance.note(rel.reg, rel.value, index);
        if (!rel.page) addRef(pc, rel.value, 0);
        continue;
      }

      // adrp の続き: add で場所そのもの、ldr/str でその中身
      const pair = Words.pairedOffset(w);
      const base = pair ? provenance.base(pair.rn, index) : null;
      if (pair && base != null) {
        const full = base + pair.imm;
        addRef(pc, full, pair.load ? 1 : pair.store ? 2 : 0);
        // ADD transfers the same path identity into Rd. Loads overwrite Rd;
        // stores only read Rt and therefore must not destroy its provenance.
        if (!pair.load && !pair.store) provenance.note(pair.rd, full, index);
        else if (pair.load) provenance.kill(pair.rd);
        continue;
      }

      // ldr literal — すぐ近くに置かれた定数
      if (kind === Words.KIND.LITERAL) {
        const t = Words.literalTarget(w, pc);
        if (t != null) addRef(pc, t, 1);
        provenance.kill(w & 0x1f);
        continue;
      }

      if (WRITES_LOW_REG[kind]) provenance.kill(w & 0x1f);
"""
once(old, new, 'scanProgram loop')

once("""  // レジスタごとに「直近の ADRP が作ったページ」を覚えておく。
  const pageOf = new Array(32).fill(null);
  const pageAt = new Array(32).fill(-1);
  let index = 0;
""", """  // scanProgram と同じ control-flow-aware provenance contract。
  const provenance = AddressProvenance.create({
    words: Words,
    pairWindow: PAIR_WINDOW,
    functionStarts: functionStartsForRegion(region),
    rangeStart: region.vmAddr,
    rangeEnd: region.vmAddr + region.size,
  });
  let index = 0;
""", 'findXrefs state')

old = """      const direct = wordTarget(w, pc);
      if (direct !== null && direct === want) {
        out.push({ row: byteOff / 4, addr: pc, kind: 'branch' });
        if (out.length >= cap) break;
        continue;
      }
      const rel = pcRelTarget(w, pc);
      if (rel) {
        pageOf[rel.reg] = rel.value;
        pageAt[rel.reg] = index;
        if (!rel.page && rel.value === want) {
          out.push({ row: byteOff / 4, addr: pc, kind: 'address' });
          if (out.length >= cap) break;
        }
        continue;
      }
      const pair = pairedOffset(w);
      if (pair && pageOf[pair.rn] != null && index - pageAt[pair.rn] <= 8) {
        const full = pageOf[pair.rn] + pair.imm;
        if (full === want) {
          out.push({
            row: byteOff / 4, addr: pc,
            kind: pair.load ? 'load' : pair.store ? 'store' : 'address',
          });
          if (out.length >= cap) break;
        }
        // ADD の結果は別レジスタに移ることがあるので、そのまま引き継ぐ
        if (!pair.load && !pair.store) { pageOf[pair.rd] = full; pageAt[pair.rd] = index; }
      }
"""
new = """      provenance.enter(pc);
      const kind = Words.classifyWord(w);
      const direct = wordTarget(w, pc);
      if (direct !== null && direct === want) {
        out.push({ row: byteOff / 4, addr: pc, kind: 'branch' });
        if (out.length >= cap) break;
      }
      if (kind === Words.KIND.CALL || kind === Words.KIND.INDCALL ||
          kind === Words.KIND.CONDBR || kind === Words.KIND.BRANCH ||
          kind === Words.KIND.RET || kind === Words.KIND.TRAP) {
        provenance.control(w, pc, kind);
        continue;
      }
      const rel = pcRelTarget(w, pc);
      if (rel) {
        provenance.note(rel.reg, rel.value, index);
        if (!rel.page && rel.value === want) {
          out.push({ row: byteOff / 4, addr: pc, kind: 'address' });
          if (out.length >= cap) break;
        }
        continue;
      }
      const pair = pairedOffset(w);
      const base = pair ? provenance.base(pair.rn, index) : null;
      if (pair && base != null) {
        const full = base + pair.imm;
        if (full === want) {
          out.push({
            row: byteOff / 4, addr: pc,
            kind: pair.load ? 'load' : pair.store ? 'store' : 'address',
          });
          if (out.length >= cap) break;
        }
        if (!pair.load && !pair.store) provenance.note(pair.rd, full, index);
        else if (pair.load) provenance.kill(pair.rd);
        continue;
      }
      if (WRITES_LOW_REG[kind]) provenance.kill(w & 0x1f);
"""
once(old, new, 'findXrefs loop')

p.write_text(text)
