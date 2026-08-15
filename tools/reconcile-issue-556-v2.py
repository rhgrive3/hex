from pathlib import Path
p = Path('js/worker-legacy.js')
text = p.read_text()

start = text.find('async function findXrefs(')
end = text.find('/* ── 任意のアドレスを読む', start)
if start < 0 or end < 0:
    raise SystemExit('findXrefs boundaries not found')
head, xref, tail = text[:start], text[start:end], text[end:]

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
if old_state in xref:
    xref = xref.replace(old_state, new_state, 1)

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
if old_pair in xref:
    xref = xref.replace(old_pair, new_pair, 1)

# Apply smaller semantic substitutions as a defensive fallback when another
# patch has already changed comments/whitespace around the same statements.
xref = xref.replace('const base = pair ? addressProvenanceBase(provenance, pair.rn, index) : null;',
                    'const base = pair ? provenance.base(pair.rn, index) : null;')
xref = xref.replace('if (!pair.load && !pair.store) { pageOf[pair.rd] = full; pageAt[pair.rd] = index; }',
                    'if (!pair.load && !pair.store) provenance.note(pair.rd, full, index);\n        else if (pair.load) provenance.kill(pair.rd);')
xref = xref.replace('noteAddressProvenance(provenance, rel.reg, rel.value, index);',
                    'provenance.note(rel.reg, rel.value, index);')

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
    if forbidden in xref:
        raise SystemExit(f'legacy findXrefs provenance survived: {forbidden}')

if 'provenance.base(pair.rn, index)' not in xref or 'provenance.enter(pc)' not in xref:
    raise SystemExit('findXrefs did not receive canonical provenance API')

p.write_text(head + xref + tail)
