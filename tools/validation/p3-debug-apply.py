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

# 2. Compatibility-only exact state-write source promotion.  A proven state-write
# MOV may expose its already-computed source as the legacy public register result.
old_state_write = """    if (inst.extra?.stateWrite && samePublicState(inst, source, inst.dst)) {
      const shadow = inst.dst;"""
new_state_write = """    const stateIdentity = inst.extra?.publicStateIdentity ?? null;
    if (inst.extra?.stateWrite && stateIdentity != null && source.reg == null
        && inst.dst.reg === stateIdentity && source.kind !== V1_VK.ARG && source.def
        && source !== inst.dst && Number(source.bits || 0) === Number(inst.dst.bits || 0)) {
      const shadow = inst.dst;
      aliases.set(shadow.id, source);
      source.reg = stateIdentity;
      source.stateKey = shadow.stateKey ?? source.stateKey ?? null;
      source.version = shadow.version ?? source.version ?? 0;
      source.compatDerived = 'exact-state-write-source';
      shadow.compatPublicIdentity = shadow.reg;
      shadow.reg = null;
      shadow.stateKey = null;
      shadow.version = 0;
      shadow.compatDerived = 'state-write-destination-shadow';
      inst.extra.compatPublicStateSourceValueId = source.id;
      inst.extra.compatStateDestinationValueId = shadow.id;
    } else if (inst.extra?.stateWrite && samePublicState(inst, source, inst.dst)) {
      const shadow = inst.dst;"""
if s.count(old_state_write) != 1:
    raise SystemExit("state-write promotion source shape mismatch")
p.write_text(s.replace(old_state_write, new_state_write, 1))

# 3. Unknown physical-state SSA definitions are public clobber boundaries.
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

# 4. Retain exact CCMP condition/fallback metadata already present in MachineEffects.
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

# 5. A register third operand denotes a variable shift even when the textual alias
# is LSL/LSR/ASR/ROR rather than LSLV/LSRV/ASRV/RORV.
replace_once(
    "js/targets/architecture/arm64/effects/integer.js",
    "  const variable = mnemonic.endsWith('v');",
    "  const variable = mnemonic.endsWith('v') || ops[2]?.k === 'reg';",
    "register-valued shift",
)
