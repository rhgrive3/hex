from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    p = Path(path)
    s = p.read_text()
    if s.count(old) != 1:
        raise SystemExit(f"{label}: expected source shape exactly once, got {s.count(old)}")
    p.write_text(s.replace(old, new, 1))


# 1. Required finalizer narrowing: only local physical-view reads may collapse.
p = Path("js/semantics/compat/semantic-ir-v2-to-v1-finalize.js")
s = p.read_text()
decl = "    const addressStateAlias = rawSource != null && aliases.has(rawSource.id);\n"
old_read = "inst.extra?.stateRead && (inst.extra?.localPhysicalViewProjection === true || addressStateAlias)"
if s.count(decl) != 1 or s.count(old_read) != 1:
    raise SystemExit("finalizer narrowing source shape mismatch")
s = s.replace(decl, "", 1).replace(
    old_read,
    "inst.extra?.stateRead && inst.extra?.localPhysicalViewProjection === true",
    1,
)

# preserveExactStateWriteSourceIdentity() has already attached a public register
# identity to a canonical producer under strict SSA/instruction/width proof.  In
# that proven case keep the producer public and compact only the state-write
# destination shadow.  Ordinary state-write projection keeps the existing policy.
old_state_write = """    if (inst.extra?.stateWrite && samePublicState(inst, source, inst.dst)) {
      const shadow = inst.dst;
      if (valueFeedsAddressOrCall(projected, shadow)) {"""
new_state_write = """    if (inst.extra?.stateWrite && samePublicState(inst, source, inst.dst)) {
      const shadow = inst.dst;
      const provenExactSource = source.compatDerived === 'exact-state-write-source';
      if (provenExactSource || valueFeedsAddressOrCall(projected, shadow)) {"""
if s.count(old_state_write) != 1:
    raise SystemExit("state-write compaction source shape mismatch")
s = s.replace(old_state_write, new_state_write, 1)
p.write_text(s)

# 2. Unknown physical-state SSA definitions are public clobber boundaries.
replace_once(
    "js/semantics/compat/semantic-ir-v2-to-v1-core.js",
    """    if (definition.kind === 'unknown') value.unknown = true;
    if (definition.kind === 'undef') value.undefined = true;""",
    """    if (definition.kind === 'unknown') {
      value.unknown = true;
      if (definition.variableKey != null) value.clobbered = true;
    }
    if (definition.kind === 'undef') value.undefined = true;""",
    "unknown physical-state clobber",
)

# 3. Retain exact CCMP condition/fallback metadata already present in MachineEffects.
p = Path("js/semantics/compat/semantic-ir-v2-to-v1-nodes.js")
s = p.read_text()
old_condition = "return attrs.conditionCode ?? op.conditionCode ?? op.condition ?? bundle.conditionCode ?? null;"
new_condition = "return attrs.conditionCode ?? op.conditionCode ?? op.condition ?? bundle.conditionCode ?? bundle.condition ?? null;"
if s.count(old_condition) != 1:
    raise SystemExit("conditionCode source shape mismatch")
s = s.replace(old_condition, new_condition, 1)
marker = """  if (primaryOutput && primaryOutput.def == null && inst.dst === primaryOutput) primaryOutput.def = inst;
  for (const extra of extraInstructions) if (extra.dst && extra.dst.def == null) extra.dst.def = extra;"""
replacement = """  const bundle = bundleMetadata(node);
  const conditionalCompare = conditionCode(node);
  if (conditionalCompare != null && bundle.fallbackNzcv != null) {
    for (const candidate of [inst, ...extraInstructions]) {
      if (candidate.op !== V1_OP.CMP) continue;
      candidate.cond = conditionalCompare;
      candidate.extra.conditional = true;
      candidate.extra.fallbackNzcv = Number(bundle.fallbackNzcv);
    }
  }
  if (primaryOutput && primaryOutput.def == null && inst.dst === primaryOutput) primaryOutput.def = inst;
  for (const extra of extraInstructions) if (extra.dst && extra.dst.def == null) extra.dst.def = extra;"""
if s.count(marker) != 1:
    raise SystemExit("projectNode final metadata source shape mismatch")
p.write_text(s.replace(marker, replacement, 1))

# 4. A register third operand denotes a variable shift even when the textual alias
# is LSL/LSR/ASR/ROR rather than LSLV/LSRV/ASRV/RORV.
replace_once(
    "js/targets/architecture/arm64/effects/integer.js",
    "  const variable = mnemonic.endsWith('v');",
    "  const variable = mnemonic.endsWith('v') || ops[2]?.k === 'reg';",
    "register-valued shift",
)
