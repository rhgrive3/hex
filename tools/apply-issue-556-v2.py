from pathlib import Path
p = Path('js/worker-legacy.js')
text = p.read_text()

def once(old, new, label):
    global text
    if new in text: return
    if old not in text: raise SystemExit(f'{label} anchor not found')
    text = text.replace(old, new, 1)

once("importScripts('./macho.js', './words.js', './worker-budget.js', '../capstone.js');",
     "importScripts('./macho.js', './words.js', './worker-budget.js', './address-provenance.js', '../capstone.js');",
     'imports')

once("""  let funcs = new BigUint64Array(0);
  let functionStartsExact = false;
""", """  let funcs = new BigUint64Array(0);
  let functionStartsExact = false;
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

section = "/* ── プログラム全体の索引（1 パスで作る） ───────────────────\n"
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
    if section not in text: raise SystemExit('program section anchor not found')
    text = text.replace(section, helper, 1)

once("""  const lo = region.vmAddr, hi = region.vmAddr + region.size;
  const provenance = makeAddressProvenance();
  let index = 0;
""", """  const lo = region.vmAddr, hi = region.vmAddr + region.size;
  const provenance = AddressProvenance.create({
    words: Words,
    pairWindow: PAIR_WINDOW,
    functionStarts: functionStartsForRegion(region),
    rangeStart: region.vmAddr,
    rangeEnd: region.vmAddr + region.size,
  });
  let index = 0;
""", 'scan provenance')

once("""      const w = dv.getUint32(i * 4, true);
      const pc = region.vmAddr + BigInt(pos + i * 4);
      const kind = Words.classifyWord(w);
""", """      const w = dv.getUint32(i * 4, true);
      const pc = region.vmAddr + BigInt(pos + i * 4);
      provenance.enter(pc);
      const kind = Words.classifyWord(w);
""", 'scan enter')

once("""        applyAddressFlowBarrier(provenance, kind);
        continue;
      }
      if (isAddressFlowBarrier(kind)) {
        applyAddressFlowBarrier(provenance, kind);
        continue;
      }
""", """        provenance.control(w, pc, kind);
        continue;
      }
      if (kind === Words.KIND.CONDBR || kind === Words.KIND.BRANCH ||
          kind === Words.KIND.RET || kind === Words.KIND.TRAP) {
        provenance.control(w, pc, kind);
        continue;
      }
""", 'scan control')

once("""        noteAddressProvenance(provenance, rel.reg, rel.value, index);
""", """        provenance.note(rel.reg, rel.value, index);
""", 'scan note')

once("""      const pair = Words.pairedOffset(w);
      const base = pair ? addressProvenanceBase(provenance, pair.rn, index) : null;
      if (pair && base != null) {
        const full = base + pair.imm;
        addRef(pc, full, pair.load ? 1 : pair.store ? 2 : 0);
        if (!pair.load && !pair.store) noteAddressProvenance(provenance, pair.rd, full, index);
        else if (pair.rd !== pair.rn) killAddressRegister(provenance, pair.rd);
        continue;
      }
""", """      const pair = Words.pairedOffset(w);
      const base = pair ? provenance.base(pair.rn, index) : null;
      if (pair && base != null) {
        const full = base + pair.imm;
        addRef(pc, full, pair.load ? 1 : pair.store ? 2 : 0);
        if (!pair.load && !pair.store) provenance.note(pair.rd, full, index);
        else if (pair.load) provenance.kill(pair.rd);
        continue;
      }
""", 'scan pair')

once("""      if (kind === Words.KIND.LITERAL) {
        const t = Words.literalTarget(w, pc);
        if (t != null) addRef(pc, t, 1);
        continue;
      }

      if (WRITES_LOW_REG[kind]) killAddressRegister(provenance, w & 0x1f);
""", """      if (kind === Words.KIND.LITERAL) {
        const t = Words.literalTarget(w, pc);
        if (t != null) addRef(pc, t, 1);
        provenance.kill(w & 0x1f);
        continue;
      }

      if (WRITES_LOW_REG[kind]) provenance.kill(w & 0x1f);
""", 'scan kills')

old_helpers = """function makeAddressProvenance() {
  return { pageOf: new Array(32).fill(null), pageAt: new Int32Array(32).fill(-1), pathOf: new Int32Array(32).fill(-1), path: 0 };
}
function clearAddressProvenance(state) {
  state.pageOf.fill(null); state.pageAt.fill(-1); state.pathOf.fill(-1); state.path++;
}
function killAddressRegister(state, reg) {
  if (reg < 0 || reg >= 32) return;
  state.pageOf[reg] = null; state.pageAt[reg] = -1; state.pathOf[reg] = -1;
}
function noteAddressProvenance(state, reg, value, index) {
  state.pageOf[reg] = value; state.pageAt[reg] = index; state.pathOf[reg] = state.path;
}
function addressProvenanceBase(state, reg, index, window = 16) {
  if (state.pathOf[reg] !== state.path || state.pageAt[reg] < 0 || index - state.pageAt[reg] > window) return null;
  return state.pageOf[reg];
}
function isAddressFlowBarrier(kind) {
  const K = Words.KIND;
  return kind === K.CONDBR || kind === K.BRANCH || kind === K.RET || kind === K.TRAP;
}
function applyAddressFlowBarrier(state, kind) {
  const K = Words.KIND;
  if (kind === K.CALL || kind === K.INDCALL) {
    for (let reg = 0; reg <= 18; reg++) killAddressRegister(state, reg);
    return;
  }
  if (isAddressFlowBarrier(kind)) clearAddressProvenance(state);
}
"""
if old_helpers in text:
    text = text.replace(old_helpers, '', 1)

once("""  // scanProgram と同じ control-flow-aware provenance contract を使う。
  const provenance = makeAddressProvenance();
  let index = 0;
""", """  const provenance = AddressProvenance.create({
    words: Words,
    pairWindow: PAIR_WINDOW,
    functionStarts: functionStartsForRegion(region),
    rangeStart: region.vmAddr,
    rangeEnd: region.vmAddr + region.size,
  });
  let index = 0;
""", 'xref provenance')

once("""      const w = dv.getUint32(i * 4, true);
      const byteOff = pos + i * 4;
      const pc = region.vmAddr + BigInt(byteOff);

      const direct = wordTarget(w, pc);
""", """      const w = dv.getUint32(i * 4, true);
      const byteOff = pos + i * 4;
      const pc = region.vmAddr + BigInt(byteOff);
      provenance.enter(pc);

      const direct = wordTarget(w, pc);
""", 'xref enter')

once("""      const kind = Words.classifyWord(w);
      if (kind === Words.KIND.CALL || kind === Words.KIND.INDCALL || isAddressFlowBarrier(kind)) {
        applyAddressFlowBarrier(provenance, kind);
        continue;
      }
""", """      const kind = Words.classifyWord(w);
      if (kind === Words.KIND.CALL || kind === Words.KIND.INDCALL ||
          kind === Words.KIND.CONDBR || kind === Words.KIND.BRANCH ||
          kind === Words.KIND.RET || kind === Words.KIND.TRAP) {
        provenance.control(w, pc, kind);
        continue;
      }
""", 'xref control')

# second occurrence is in findXrefs after scan replacement
old = "noteAddressProvenance(provenance, rel.reg, rel.value, index);"
if old in text: text = text.replace(old, "provenance.note(rel.reg, rel.value, index);", 1)

once("""      const pair = pairedOffset(w);
      const base = pair ? addressProvenanceBase(provenance, pair.rn, index) : null;
      if (pair && base != null) {
        const full = base + pair.imm;
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
""", """      const pair = pairedOffset(w);
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
""", 'xref pair')

p.write_text(text)
