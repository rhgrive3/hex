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

# Preserve the legacy signed stack-slot display convention. Stack identity and
# offsets remain canonical/signed; this changes only the v1 human-facing name.
old_stack_name = "name: `${disp < 0n ? 'var_m' : 'var_'}${magnitude.toString(16)}`"
new_stack_name = "name: `${disp < 0n ? 'var_m' : 'var_p'}${magnitude.toString(16)}`"
if s.count(old_stack_name) != 1:
    raise SystemExit("stack slot display source shape mismatch")
s = s.replace(old_stack_name, new_stack_name, 1)
p.write_text(s)

# Address constants are bitvectors, so a negative architectural displacement is
# serialized as its two's-complement unsigned value. For a proven affine
# base+constant address projection, normalize that offset to the signed value of
# the address width. This changes only the v1 affine display/location shape; the
# canonical bitvector address semantics remain unchanged.
p = Path("js/semantics/compat/semantic-ir-v2-to-v1-address.js")
s = p.read_text()
old_right = """      if (left && left.precise) {
        const delta = producer.operator === 'sub' ? -rightConst : rightConst;
        result = { ...left, disp: (left.disp ?? 0n) + delta, origin: mergeOrigins(left.origin, producer.origin, rightNode.origin, semanticValue?.origin) };
      }"""
new_right = """      if (left && left.precise) {
        const addressBits = Math.max(1, Number(left.addressWidthBits || 64));
        const signedOffset = BigInt.asIntN(addressBits, rightConst);
        const delta = producer.operator === 'sub' ? -signedOffset : signedOffset;
        result = { ...left, disp: (left.disp ?? 0n) + delta, origin: mergeOrigins(left.origin, producer.origin, rightNode.origin, semanticValue?.origin) };
      }"""
if s.count(old_right) != 1:
    raise SystemExit("right affine offset source shape mismatch")
s = s.replace(old_right, new_right, 1)
old_left = """      if (right && right.precise) {
        result = { ...right, disp: (right.disp ?? 0n) + leftConst, origin: mergeOrigins(right.origin, producer.origin, leftNode.origin, semanticValue?.origin) };
      }"""
new_left = """      if (right && right.precise) {
        const addressBits = Math.max(1, Number(right.addressWidthBits || 64));
        const signedOffset = BigInt.asIntN(addressBits, leftConst);
        result = { ...right, disp: (right.disp ?? 0n) + signedOffset, origin: mergeOrigins(right.origin, producer.origin, leftNode.origin, semanticValue?.origin) };
      }"""
if s.count(old_left) != 1:
    raise SystemExit("left affine offset source shape mismatch")
p.write_text(s.replace(old_left, new_left, 1))

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

# 5. Typed call-return evidence belongs at the AAPCS64 compatibility facade.
# Resolve it from the original decoded call + current options (the same authority
# used by explicit legacy-v1), then expose only a compatibility value. Untyped
# calls still have dst=null and no fabricated return result.
p = Path("js/ir-core.js")
s = p.read_text()
call_marker = """function valueMayCarryStackAddress(value) {
"""
helper = """function attachAapcs64TypedCallResults(projected, instructionByRow, options = {}) {
  for (const inst of projected.instructions ?? []) {
    if (inst.op !== LEGACY_OP.CALL || inst.dst) continue;
    const decoded = instructionByRow.get(inst.row) ?? null;
    const result = decoded == null ? null : AAPCS64_ABI.classifyCallReturn(decoded, options);
    if (!result?.reg) continue;
    const reg = String(result.reg);
    const bits = Number(result.bits || 64);
    const candidates = (projected.values ?? [])
      .filter((value) => value?.reg === reg
        && value?.sourceEntityId === inst.semanticNodeId
        && value?.def == null)
      .sort((left, right) => Number(right.id ?? -1) - Number(left.id ?? -1));
    const priorVersion = Math.max(-1, ...(projected.values ?? [])
      .filter((value) => value?.reg === reg)
      .map((value) => Number(value.version ?? -1)));
    const value = candidates[0] ?? {
      id: (projected.values ?? []).length,
      vid: (projected.values ?? []).length + 1,
      kind: LEGACY_VK.DEF,
      reg,
      stateKey: null,
      version: priorVersion + 1,
      bits,
      def: null,
      uses: [],
      const: null,
      range: null,
      signed: null,
      nullable: null,
      type: null,
      label: reg,
      semanticValueId: null,
      semanticSsaValueId: null,
      sourceEntityId: inst.semanticNodeId,
      machineType: null,
      origin: inst.origin ?? null,
      compatibilityShapeOnly: true,
    };
    if (!candidates[0]) projected.values.push(value);
    value.kind = LEGACY_VK.DEF;
    value.reg = reg;
    value.bits = bits;
    value.def = inst;
    value.unknown = true;
    delete value.undefined;
    delete value.clobbered;
    value.compatDerived = 'typed-abi-call-result';
    inst.dst = value;
    inst.returnReg = reg;
    inst.returnBits = bits;
    inst.returnEvidence = 'prototype-aapcs64-call';
    inst.extra = {
      ...(inst.extra ?? {}),
      compatTypedCallResult: true,
      compatTypedCallResultEvidence: inst.returnEvidence,
    };
  }
}

"""
if s.count(call_marker) != 1 or "function attachAapcs64TypedCallResults(projected" in s:
    raise SystemExit("typed call result insertion source shape mismatch")
s = s.replace(call_marker, helper + call_marker, 1)
old_call = """  attachAapcs64CallArguments(result.legacyV1);
  invalidateEscapedStackForwarding(result.legacyV1);"""
new_call = """  attachAapcs64CallArguments(result.legacyV1);
  attachAapcs64TypedCallResults(result.legacyV1, instructionByRow, opts);
  invalidateEscapedStackForwarding(result.legacyV1);"""
if s.count(old_call) != 1:
    raise SystemExit("typed call result wiring source shape mismatch")
p.write_text(s.replace(old_call, new_call, 1))
