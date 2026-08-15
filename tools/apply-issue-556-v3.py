from pathlib import Path
p = Path('js/worker-legacy.js')
text = p.read_text()

def rep(old, new, label):
    global text
    if old not in text:
        raise SystemExit(f'{label} anchor not found')
    text = text.replace(old, new, 1)

rep("importScripts('./macho.js', './words.js', './worker-budget.js', '../capstone.js');",
    "importScripts('./macho.js', './words.js', './worker-budget.js', './address-provenance.js', '../capstone.js');",
    'imports')

rep("""  let funcs = new BigUint64Array(0);
  let functionStartsExact = false;
""", """  let funcs = new BigUint64Array(0);
  let functionStartsExact = false;
  // Exact decoded starts (plus the Mach-O entry seed) are also the hard
  // control-flow roots for ADR/ADRP provenance in the worker scans.
  slice.functionStarts = [];
""", 'function starts init')

rep("""      seeds.sort((a,b)=>(a<b?-1:a>b?1:0));
      funcs = new BigUint64Array(seeds.length);
      for (let i = 0; i < seeds.length; i++) funcs[i] = seeds[i];
      functionStartsExact = list.length > 0 && list.complete === true;
    } catch { funcs = new BigUint64Array(0); }
  }

  if ((!info.functionStarts || !info.functionStarts.datasize) && info.entry != null) {
    funcs = new BigUint64Array([info.entry]);
    functionStartsExact = false;
  }
""", """      seeds.sort((a,b)=>(a<b?-1:a>b?1:0));
      slice.functionStarts = seeds;
      funcs = new BigUint64Array(seeds.length);
      for (let i = 0; i < seeds.length; i++) funcs[i] = seeds[i];
      functionStartsExact = list.length > 0 && list.complete === true;
    } catch { slice.functionStarts = []; funcs = new BigUint64Array(0); }
  }

  if ((!info.functionStarts || !info.functionStarts.datasize) && info.entry != null) {
    slice.functionStarts = [info.entry];
    funcs = new BigUint64Array([info.entry]);
    functionStartsExact = false;
  }
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
rep(section, helper, 'program section')

rep("""  const lo = region.vmAddr, hi = region.vmAddr + region.size;
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
""", 'scan state')

rep("""      const w = dv.getUint32(i * 4, true);
      const pc = region.vmAddr + BigInt(pos + i * 4);
      const kind = Words.classifyWord(w);
""", """      const w = dv.getUint32(i * 4, true);
      const pc = region.vmAddr + BigInt(pos + i * 4);
      provenance.enter(pc);
      const kind = Words.classifyWord(w);
""", 'scan enter')

rep("""        applyAddressFlowBarrier(provenance, kind);
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

rep('noteAddressProvenance(provenance, rel.reg, rel.value, index);',
    'provenance.note(rel.reg, rel.value, index);', 'scan note')

rep("""      const pair = Words.pairedOffset(w);
      const base = pair ? addressProvenanceBase(provenance, pair.rn, index) : null;
      if (pair && base != null) {
        const full = base + pair.imm;
        addRef(pc, full, pair.load ? 1 : pair.store ? 2 : 0);
        if (!pair.load && !pair.store) noteAddressProvenance(provenance, pair.rd, full, index);
        else if (pair.rd !== pair.rn) killAddressRegister(provenance, pair.rd);
        continue;
      }

      if (kind === Words.KIND.LITERAL) {
        const t = Words.literalTarget(w, pc);
        if (t != null) addRef(pc, t, 1);
        continue;
      }

      if (WRITES_LOW_REG[kind]) killAddressRegister(provenance, w & 0x1f);
""", """      const pair = Words.pairedOffset(w);
      const base = pair ? provenance.base(pair.rn, index) : null;
      if (pair && base != null) {
        const full = base + pair.imm;
        addRef(pc, full, pair.load ? 1 : pair.store ? 2 : 0);
        if (!pair.load && !pair.store) provenance.note(pair.rd, full, index);
        else if (pair.load) provenance.kill(pair.rd);
        continue;
      }

      if (kind === Words.KIND.LITERAL) {
        const t = Words.literalTarget(w, pc);
        if (t != null) addRef(pc, t, 1);
        provenance.kill(w & 0x1f);
        continue;
      }

      if (WRITES_LOW_REG[kind]) provenance.kill(w & 0x1f);
""", 'scan pair/kill')

legacy_helpers = """function makeAddressProvenance() {
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
rep(legacy_helpers, '', 'legacy helper block')

rep("""  // scanProgram と同じ control-flow-aware provenance contract を使う。
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
""", 'xref state')

rep("""      const w = dv.getUint32(i * 4, true);
      const byteOff = pos + i * 4;
      const pc = region.vmAddr + BigInt(byteOff);

      const direct = wordTarget(w, pc);
""", """      const w = dv.getUint32(i * 4, true);
      const byteOff = pos + i * 4;
      const pc = region.vmAddr + BigInt(byteOff);
      provenance.enter(pc);

      const direct = wordTarget(w, pc);
""", 'xref enter')

rep("""      const kind = Words.classifyWord(w);
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

rep('noteAddressProvenance(provenance, rel.reg, rel.value, index);',
    'provenance.note(rel.reg, rel.value, index);', 'xref note')

rep("""      const pair = pairedOffset(w);
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

# Fail closed if either scan still has the duplicated/unsound #571 state machine.
for forbidden in ['makeAddressProvenance(', 'addressProvenanceBase(', 'noteAddressProvenance(',
                  'killAddressRegister(', 'applyAddressFlowBarrier(', 'isAddressFlowBarrier(',
                  'pageOf[pair.rd]', 'pageAt[pair.rd]']:
    if forbidden in text:
        raise SystemExit(f'legacy provenance survived: {forbidden}')
if text.count('AddressProvenance.create(') < 2 or text.count('provenance.enter(pc)') < 2:
    raise SystemExit('shared provenance not wired into both scans')

p.write_text(text)
