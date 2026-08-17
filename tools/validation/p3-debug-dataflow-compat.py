from pathlib import Path

# Hide compatibility-only state/cast bridge nodes from the stable public RMW
# step list. They preserve exact v2 state/value width semantics but are not
# machine-level arithmetic steps and legacy consumers expect one semantic step
# for a one-instruction add/sub update.
p = Path("js/dataflow-ir.js")
s = p.read_text()
old = """function stepFrom(inst, loadValue, callByRow, originMemo) {
  const op = operationName(inst);
  if (!op) return null;"""
new = """function stepFrom(inst, loadValue, callByRow, originMemo) {
  if (inst?.op === OP.MOV && (
    inst.extra?.stateRead || inst.extra?.stateWrite ||
    ['trunc', 'zext', 'sext', 'bitcast'].includes(inst.sub)
  )) return null;
  const op = operationName(inst);
  if (!op) return null;"""
if s.count(old) != 1:
    raise SystemExit(f"RMW public-step source shape mismatch: {s.count(old)}")
p.write_text(s.replace(old, new, 1))

# ObjC property helpers receive the ivar-offset variable in x2. In v2 compat a
# signed load is represented as LOAD -> exact sign-extension -> state write.
# Follow those provenance-preserving casts back to the proved global load; do
# not rescan ARM64 text or guess an offset.
p = Path("js/dataflow-semantic.js")
s = p.read_text()
old_pass = """const PASS_UN = new Set(['sxt8', 'sxt16', 'sxt32', 'uxt8', 'uxt16', 'uxt32', 'fmov']);"""
new_pass = """const PASS_UN = new Set([
  'sxt8', 'sxt16', 'sxt32', 'uxt8', 'uxt16', 'uxt32', 'fmov',
  'sext', 'zext', 'trunc', 'bitcast',
]);"""
if s.count(old_pass) != 1:
    raise SystemExit(f"transparent cast set source shape mismatch: {s.count(old_pass)}")
s = s.replace(old_pass, new_pass, 1)
old_helper = """  const origin = originOf(offsetValue);
  if (origin && origin.kind === 'global' && origin.address != null) {
    return {
      base: 'x0', disp: null, size: 8, stack: false,
      key: 'x0@iv' + origin.address.toString(), indexAddr: origin.address, self: true,
      irKey: null, irKind: MK.FIELD,
    };
  }"""
new_helper = """  const load = rootLoad(offsetValue);
  if (load?.loc?.kind === MK.GLOBAL && load.loc.address != null) {
    return {
      base: 'x0', disp: null, size: 8, stack: false,
      key: 'x0@iv' + load.loc.address.toString(), indexAddr: load.loc.address, self: true,
      irKey: null, irKind: MK.FIELD,
    };
  }
  const origin = originOf(offsetValue);
  if (origin && origin.kind === 'global' && origin.address != null) {
    return {
      base: 'x0', disp: null, size: 8, stack: false,
      key: 'x0@iv' + origin.address.toString(), indexAddr: origin.address, self: true,
      irKey: null, irKind: MK.FIELD,
    };
  }"""
if s.count(old_helper) != 1:
    raise SystemExit(f"property helper location source shape mismatch: {s.count(old_helper)}")
p.write_text(s.replace(old_helper, new_helper, 1))
