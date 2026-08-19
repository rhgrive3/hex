from pathlib import Path

path = Path('tests/machine-effects/arm64-atomic-ordering.test.mjs')
text = path.read_text()
old = """  const b = liftAtomic('clrex', []);
  assert.equal(b.completeness, 'exact-with-intrinsic');
  assert.equal(b.operations[0].intrinsicId, 'arm64.exclusive-monitor-clear');
"""
new = """  const b = liftAtomic('clrex', []);
  assert.equal(b.completeness, 'exact-with-intrinsic');
  const clear = b.operations.find((op) => op.kind === 'intrinsic' && op.intrinsicId === 'arm64.exclusive-monitor-clear');
  assert.ok(clear, 'CLREX must retain the explicit clear intrinsic after canonical monitor-state reads');
"""
if text.count(old) != 1:
    raise SystemExit(f'#929 current CLREX test anchor expected once, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))
