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
# identity to a canonical producer under strict SSA/instruction/width proof.
# Legacy v1 exposes a proven LOAD producer itself as the destination register;
# other exact producers retain the existing state-write projection behavior.
old_state_write = """    if (inst.extra?.stateWrite && samePublicState(inst, source, inst.dst)) {
      const shadow = inst.dst;
      if (valueFeedsAddressOrCall(projected, shadow)) {"""
new_state_write = """    if (inst.extra?.stateWrite && samePublicState(inst, source, inst.dst)) {
      const shadow = inst.dst;
      const provenExactLoadSource = source.compatDerived === 'exact-state-write-source' && source.def?.op === V1_OP.LOAD;
      if (provenExactLoadSource || valueFeedsAddressOrCall(projected, shadow)) {"""
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

# 5. A typed ABI return is positive evidence. Reuse the call's existing canonical
# physical-state definition instead of inventing a second semantic value. Unknown
# calls without typed return evidence remain dst=null.
p = Path("js/ir-core.js")
s = p.read_text()
call_marker = """function valueMayCarryStackAddress(value) {
"""
helper = """function attachAapcs64TypedCallResults(projected) {
  for (const inst of projected.instructions ?? []) {
    if (inst.op !== LEGACY_OP.CALL || inst.dst || !inst.returnReg || !inst.returnEvidence) continue;
    const candidates = (projected.values ?? [])
      .filter((value) => value?.reg === inst.returnReg
        && value?.sourceEntityId === inst.semanticNodeId
        && value?.def == null)
      .sort((left, right) => Number(right.id ?? -1) - Number(left.id ?? -1));
    const value = candidates[0] ?? null;
    if (!value) continue;
    value.kind = LEGACY_VK.DEF;
    value.bits = Number(inst.returnBits || value.bits || 64);
    value.def = inst;
    value.unknown = true;
    delete value.undefined;
    delete value.clobbered;
    value.compatDerived = 'typed-abi-call-result';
    inst.dst = value;
    inst.extra = {
      ...(inst.extra ?? {}),
      compatTypedCallResult: true,
      compatTypedCallResultEvidence: inst.returnEvidence,
    };
  }
}

"""
if s.count(call_marker) != 1 or "function attachAapcs64TypedCallResults(projected)" in s:
    raise SystemExit("typed call result insertion source shape mismatch")
s = s.replace(call_marker, helper + call_marker, 1)
old_call = """  attachAapcs64CallArguments(result.legacyV1);
  invalidateEscapedStackForwarding(result.legacyV1);"""
new_call = """  attachAapcs64CallArguments(result.legacyV1);
  attachAapcs64TypedCallResults(result.legacyV1);
  invalidateEscapedStackForwarding(result.legacyV1);"""
if s.count(old_call) != 1:
    raise SystemExit("typed call result wiring source shape mismatch")
p.write_text(s.replace(old_call, new_call, 1))
