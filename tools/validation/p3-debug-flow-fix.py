from pathlib import Path

# RMW public steps should describe semantic computation, not compatibility
# transport nodes introduced by v2->v1 projection.
p = Path('js/dataflow-ir.js')
s = p.read_text()
old = """function stepFrom(inst, loadValue, callByRow, originMemo) {
  const op = operationName(inst);
  if (!op) return null;
"""
new = """function stepFrom(inst, loadValue, callByRow, originMemo) {
  // MOV/state bridge/cast nodes preserve or re-express the value; they are not
  // user-visible update operations. Likewise PASS_UN casts are transport.
  if (inst?.op === OP.MOV || (inst?.op === OP.UN && PASS_UN.has(inst.sub))) return null;
  const op = operationName(inst);
  if (!op) return null;
"""
if s.count(old) != 1:
    raise SystemExit(f'dataflow step source mismatch: {s.count(old)}')
p.write_text(s.replace(old, new, 1))

# A direct external B that the semantic model already records as a concrete
# recognized call is a compatibility tail-call candidate. Restrict this to
# direct known targets; propertyHelperUpdate still requires a recognized helper.
p = Path('js/dataflow-semantic.js')
s = p.read_text()
old = """    const meta = callByRow.get(inst.row) || null;
    if (!meta || (!meta.tail && inst.op !== OP.CALL)) continue;
    const helper = helperSemantics(meta);
"""
new = """    const meta = callByRow.get(inst.row) || null;
    if (!meta) continue;
    const directTailBranch = inst.op === OP.BR && meta.indirect === false && meta.target != null;
    if (!meta.tail && inst.op !== OP.CALL && !directTailBranch) continue;
    const helper = helperSemantics(meta);
"""
if s.count(old) != 1:
    raise SystemExit(f'property helper tail source mismatch: {s.count(old)}')
p.write_text(s.replace(old, new, 1))
