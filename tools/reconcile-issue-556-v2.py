from pathlib import Path
p = Path('js/worker-legacy.js')
text = p.read_text()

old_state = """  // scanProgram と同じ control-flow-aware provenance contract を使う。
  const provenance = makeAddressProvenance();
  let index = 0;
"""
new_state = """  const provenance = AddressProvenance.create({
    words: Words,
    pairWindow: PAIR_WINDOW,
    functionStarts: functionStartsForRegion(region),
    rangeStart: region.vmAddr,
    rangeEnd: region.vmAddr + region.size,
  });
  let index = 0;
"""
if old_state in text:
    text = text.replace(old_state, new_state, 1)

old_pair = """      const pair = pairedOffset(w);
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
"""
new_pair = """      const pair = pairedOffset(w);
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
if old_pair in text:
    text = text.replace(old_pair, new_pair, 1)

# The corrected worker must have one provenance implementation only. If any of
# #571's duplicated state machine survives, fail before behavioral tests.
for forbidden in [
    'makeAddressProvenance()',
    'addressProvenanceBase(',
    'noteAddressProvenance(',
    'killAddressRegister(',
    'applyAddressFlowBarrier(',
    'isAddressFlowBarrier(',
    'pageOf[pair.rd]',
    'pageAt[pair.rd]',
]:
    if forbidden in text:
        raise SystemExit(f'legacy provenance survived: {forbidden}')

p.write_text(text)
