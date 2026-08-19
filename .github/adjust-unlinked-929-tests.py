from pathlib import Path

path = Path('tests/machine-effects/arm64-atomic-ordering.test.mjs')
text = path.read_text()
old = """  b = lift('clrex', []);\n  assert.equal(b.operations[0].intrinsicId, 'arm64.exclusive-monitor-clear');\n  assert.equal(b.operations[0].effectSummary.memory.write.scope, 'none');\n"""
new = """  b = lift('clrex', []);\n  const clear = b.operations.find((op) => op.kind === 'intrinsic' && op.intrinsicId === 'arm64.exclusive-monitor-clear');\n  assert.ok(clear, 'CLREX must retain the explicit clear intrinsic after canonical monitor-state reads');\n  assert.equal(clear.effectSummary.memory.write.scope, 'none');\n"""
if text.count(old) != 1:
    raise SystemExit(f'#929 existing CLREX test anchor expected once, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))
