from pathlib import Path

p = Path('tests/phase6/generic-core/issues-890-895.test.mjs')
text = p.read_text()
old = "  assert.ok(bundle.operations.some((op) => op.kind === 'register-write' && op.register?.id === 'rcx'));"
new = "  assert.ok(bundle.operations.some((op) => op.kind === 'register-write' && op.metadata?.view === 'rcx'));"
if text.count(old) != 1:
    raise SystemExit('x86 loop assertion anchor mismatch')
text = text.replace(old, new, 1)
old = """function fence(fields, id) {
  return liftRiscv64SystemEffects({
    instructionId:id, address:0x4000n, size:4, mode:'rv64imc',
    fields:{ supported:true, op:'fence', compressed:false, ...fields },
  });
}"""
new = """function fence(fields, id) {
  const word = (BigInt(fields.fenceMode) << 28n)
    | (BigInt(fields.predecessor) << 24n)
    | (BigInt(fields.successor) << 20n)
    | 0x0fn;
  const rawBytes = Array.from({ length:4 }, (_unused, index) => Number((word >> BigInt(index * 8)) & 0xffn));
  return liftRiscv64SystemEffects({
    instructionId:id, address:0x4000n, size:4, mode:'rv64imc', rawBytes,
  });
}"""
if text.count(old) != 1:
    raise SystemExit('riscv fence fixture anchor mismatch')
p.write_text(text.replace(old, new, 1))
