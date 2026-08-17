from pathlib import Path

p = Path('js/semantics/compat/semantic-ir-v2-to-v1-finalize.js')
s = p.read_text()

broad = "name: `${disp < 0n ? 'var_m' : 'var_p'}${magnitude.toString(16)}`"
legacy = "name: `${disp < 0n ? 'var_m' : 'var_'}${magnitude.toString(16)}`"
if s.count(broad) != 1:
    raise SystemExit(f'broad positive stack name shape mismatch: {s.count(broad)}')
s = s.replace(broad, legacy, 1)

old = """  projected.stackSlots = [...byKey.values()].sort((left, right) => left.offset < right.offset ? -1 : left.offset > right.offset ? 1 : left.key.localeCompare(right.key));
}"""
new = """  const slots = [...byKey.values()];
  const signsByMagnitude = new Map();
  for (const slot of slots) {
    const magnitude = slot.offset < 0n ? -slot.offset : slot.offset;
    let signs = signsByMagnitude.get(magnitude.toString());
    if (!signs) { signs = { positive:false, negative:false }; signsByMagnitude.set(magnitude.toString(), signs); }
    if (slot.offset < 0n) signs.negative = true;
    else signs.positive = true;
  }
  for (const slot of slots) {
    if (slot.offset < 0n) continue;
    const magnitude = slot.offset;
    const signs = signsByMagnitude.get(magnitude.toString());
    if (signs?.positive && signs?.negative) slot.name = `var_p${magnitude.toString(16)}`;
  }
  projected.stackSlots = slots.sort((left, right) => left.offset < right.offset ? -1 : left.offset > right.offset ? 1 : left.key.localeCompare(right.key));
}"""
if s.count(old) != 1:
    raise SystemExit(f'stack slot finalization shape mismatch: {s.count(old)}')
p.write_text(s.replace(old, new, 1))
