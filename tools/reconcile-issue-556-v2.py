from pathlib import Path
p = Path('js/worker-legacy.js')
text = p.read_text()
old = """  // scanProgram と同じ control-flow-aware provenance contract を使う。
  const provenance = makeAddressProvenance();
  let index = 0;
"""
new = """  const provenance = AddressProvenance.create({
    words: Words,
    pairWindow: PAIR_WINDOW,
    functionStarts: functionStartsForRegion(region),
    rangeStart: region.vmAddr,
    rangeEnd: region.vmAddr + region.size,
  });
  let index = 0;
"""
if old in text:
    text = text.replace(old, new, 1)
# Fail loudly if any legacy provenance implementation/call survives. This is the
# exact regression #571 introduced into findXrefs.
for forbidden in ['makeAddressProvenance()', 'pageOf[pair.rd]', 'pageAt[pair.rd]']:
    if forbidden in text:
        raise SystemExit(f'legacy provenance survived: {forbidden}')
p.write_text(text)
