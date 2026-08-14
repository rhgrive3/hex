from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(rel, before, after, label):
    path = ROOT / rel
    text = path.read_text()
    count = text.count(before)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match in {rel}, found {count}")
    path.write_text(text.replace(before, after, 1))


# A constant is a string only when the exact address-producing SSA definition is
# tied to an addressRef with text. Do not reinterpret arbitrary integer constants.
replace_once(
    "js/decompiler/semantic.js",
    r'''function stringLiteralAt(addr, ctx) {
  if (addr == null) return null;
  try {
    const direct = ctx.opts.stringFor?.(BigInt(addr));
    if (typeof direct === 'string') return JSON.stringify(direct);
  } catch { /* optional resolver */ }
  for (const ref of ctx.model.addressRefs || []) {
    if (ref?.addr == null || typeof ref.text !== 'string') continue;
    try { if (BigInt(ref.addr) === BigInt(addr)) return JSON.stringify(ref.text); } catch { /* malformed ref */ }
  }
  return null;
}
''',
    r'''function stringLiteralAt(addr, ctx) {
  if (addr == null) return null;
  try {
    const direct = ctx.opts.stringFor?.(BigInt(addr));
    if (typeof direct === 'string') return JSON.stringify(direct);
  } catch { /* optional resolver */ }
  for (const ref of ctx.model.addressRefs || []) {
    if (ref?.addr == null || typeof ref.text !== 'string') continue;
    try { if (BigInt(ref.addr) === BigInt(addr)) return JSON.stringify(ref.text); } catch { /* malformed ref */ }
  }
  return null;
}

function stringLiteralForValue(value, ctx) {
  if (value?.const == null) return null;
  const defRow = value.def?.row;
  for (const ref of ctx.model.addressRefs || []) {
    if (ref?.row !== defRow || ref?.addr == null || typeof ref.text !== 'string') continue;
    try { if (BigInt(ref.addr) === BigInt(value.const)) return JSON.stringify(ref.text); } catch { /* malformed ref */ }
  }
  // A direct ADR/ADRP value is intrinsically address-like. For arithmetic
  // constants require the exact row+addressRef proof above.
  return value.def?.op === OP.ADDR ? stringLiteralAt(value.const, ctx) : null;
}
''',
    "value-specific string literal proof",
)
replace_once(
    "js/decompiler/semantic.js",
    "  if (value.const != null && value.def?.op !== OP.ADDR) out = formatConst(value.const, value.bits);\n",
    "  if (value.const != null && value.def?.op !== OP.ADDR) out = stringLiteralForValue(value, ctx) || formatConst(value.const, value.bits);\n",
    "constant address literal rendering",
)
replace_once(
    "js/decompiler/semantic.js",
    r'''    } else if (d.op === OP.ADDR) {
      const addr = value.const ?? d.extra?.value ?? d.extra?.target;
      const literal = stringLiteralAt(addr, ctx);
      out = literal || (addr != null ? (ctx.opts.symbolFor?.(addr) ? safeIdent(ctx.opts.symbolFor(addr)) : `&global_${hex(addr)}`) : 'address_unknown');
''',
    r'''    } else if (d.op === OP.ADDR) {
      const addr = value.const ?? d.extra?.value ?? d.extra?.target;
      const literal = stringLiteralForValue(value, ctx) || stringLiteralAt(addr, ctx);
      out = literal || (addr != null ? (ctx.opts.symbolFor?.(addr) ? safeIdent(ctx.opts.symbolFor(addr)) : `&global_${hex(addr)}`) : 'address_unknown');
''',
    "direct address literal rendering",
)

# Keep lvalue-address dependencies carried by the semantic line. This is what
# makes the zero-store own 4B8 (zero), 4BC (receiver reload), and 4C0 (store).
replace_once(
    "js/decompiler/pipeline-core.js",
    "    return { text, semantic: { op: 'store', location, expression: e, ir: store.id }, source: mergeSource(e?.source, origin(store, store.dst)) };\n",
    "    return { text, semantic: { op: 'store', location, expression: e, ir: store.id }, source: mergeSource(line.source, e?.source, origin(store, store.dst)) };\n",
    "typed store lvalue provenance",
)
replace_once(
    "js/decompiler/pipeline-core.js",
    "    if (rv) { const e = expressionFor(rv, state); return { text: `return ${printExpression(e)};`, semantic: { op: 'return', expression: e, ir: ret.id }, source: mergeSource(e?.source, origin(ret, rv)) }; }\n",
    "    if (rv) { const e = expressionFor(rv, state); return { text: `return ${printExpression(e)};`, semantic: { op: 'return', expression: e, ir: ret.id }, source: mergeSource(line.source, e?.source, origin(ret, rv)) }; }\n",
    "typed return carried provenance",
)

# Memory SSA already computes per-call memory kills. A call is a barrier for a
# stack slot only when that slot is in memKills. This exactly matches the IR's
# escape/alias proof and avoids the old unconditional call barrier.
replace_once(
    "js/decompiler/passes/stack-return-recovery.js",
    r'''function unsafeBarrier(inst, key) {
  if (inst?.op === 'call' || inst?.op === 'clobber' || inst?.op === 'unknown') return true;
  return inst?.op === 'store' && inst.loc?.key !== key && (!inst.loc?.key || inst.loc?.kind === 'unknown');
}
''',
    r'''function unsafeBarrier(inst, key) {
  if (inst?.op === 'clobber' || inst?.op === 'unknown') return true;
  if (inst?.op === 'call') {
    // buildMemorySSA has already proven which locations this call can kill.
    // A private caller stack slot is absent from memKills and is safe to carry
    // through the call; an escaped stack address is present and remains a barrier.
    return (inst.memKills || []).some((loc) => loc?.key === key);
  }
  return inst?.op === 'store' && inst.loc?.key !== key && (!inst.loc?.key || inst.loc?.kind === 'unknown');
}
''',
    "memory-ssa call barrier",
)

# If a value PHI reaches a private return spill and every incoming predecessor
# committed that exact value to the same high-level lvalue, the source-level
# state at the merge is that lvalue. This turns the compiler's
# store-to-stack/call/reload return preservation into `return self->field`.
replace_once(
    "js/decompiler/passes/stack-return-recovery.js",
    "import { expr, structuralKey } from '../ast/nodes.js';\n",
    "import { expr, structuralKey } from '../ast/nodes.js';\n",
    "stack pass import anchor",
)
replace_once(
    "js/decompiler/passes/stack-return-recovery.js",
    r'''function storeValue(inst, key, values) {
  if (inst?.op !== 'store' || inst.loc?.key !== key) return null;
  let node = expressionOf(valueOf(inst.args?.[0]), values);
  if (!node) return null;
  const bytes = Number(inst.size || inst.loc?.size || inst.addr?.size || 0);
  const bits = bytes > 0 ? bytes * 8 : 0;
  if (bits) node = fitWidth(node, bits, {
    address:inst.address,
    row:inst.row,
    ir:inst.id,
    evidence:[{ reason:`exact ${bits}-bit stack-store boundary` }],
  });
  return node;
}
''',
    r'''function storeValue(inst, key, values) {
  if (inst?.op !== 'store' || inst.loc?.key !== key) return null;
  let node = expressionOf(valueOf(inst.args?.[0]), values);
  if (!node) return null;
  const bytes = Number(inst.size || inst.loc?.size || inst.addr?.size || 0);
  const bits = bytes > 0 ? bytes * 8 : 0;
  if (bits) node = fitWidth(node, bits, {
    address:inst.address,
    row:inst.row,
    ir:inst.id,
    evidence:[{ reason:`exact ${bits}-bit stack-store boundary` }],
  });
  return node;
}

function latestStoreTo(ir, blockIndex, beforeRow, key) {
  let best = null;
  for (const inst of ir?.blocks?.[blockIndex]?.insts || []) {
    if (inst?.op !== 'store' || inst.loc?.key !== key) continue;
    if (beforeRow != null && inst.row >= beforeRow) continue;
    if (!best || (inst.row ?? -1) > (best.row ?? -1)) best = inst;
  }
  return best;
}

function storeOfExactValue(ir, blockIndex, value) {
  let best = null;
  for (const inst of ir?.blocks?.[blockIndex]?.insts || []) {
    if (inst?.op !== 'store' || inst.loc?.kind === 'stack' || inst.loc?.kind === 'unknown') continue;
    if (valueOf(inst.args?.[0])?.id !== value?.id) continue;
    if (!best || (inst.row ?? -1) > (best.row ?? -1)) best = inst;
  }
  return best;
}

function semanticLocationForStore(result, store) {
  return (result.semanticAst?.stores || []).find((item) =>
    (item.source?.ir || []).some((id) => Number(id) === Number(store?.id)))?.location || null;
}

function locationIdentity(location) {
  if (!location) return null;
  if (location.kind === 'field') {
    return `field:${location.offset ?? ''}:${location.name || ''}:${structuralKey(location.base)}`;
  }
  if (location.kind === 'index') {
    return `index:${location.scale || 1}:${structuralKey(location.base)}:${structuralKey(location.index)}`;
  }
  return `${location.kind}:${location.key || location.text || location.name || ''}`;
}

function committedLocationForPhi(result, value) {
  const phi = value?.def;
  if (phi?.op !== 'phi' || !(phi.incoming || []).length) return null;
  const locations = [];
  for (const incoming of phi.incoming || []) {
    const store = storeOfExactValue(result.ir, incoming.from, incoming.value);
    if (!store) return null;
    const location = semanticLocationForStore(result, store);
    if (!location) return null;
    locations.push(location);
  }
  const identity = locationIdentity(locations[0]);
  if (!identity || locations.some((loc) => locationIdentity(loc) !== identity)) return null;
  return locations[0];
}

function committedReturnValue(result, root, ret) {
  if (root?.kind !== 'load' || root.location?.kind !== 'stack' || !root.location?.key) return null;
  const load = [...(result.ir.instructions || [])].reverse().find((inst) =>
    inst?.op === 'load' && inst.loc?.key === root.location.key && inst.row < ret.row && inst.dst?.reg === 'x0');
  if (!load) return null;
  const stackStore = latestStoreTo(result.ir, load.block, load.row, root.location.key);
  const spilled = valueOf(stackStore?.args?.[0]);
  const location = committedLocationForPhi(result, spilled);
  if (!location) return null;
  return expr.load(location, root.bits || 64, root.source, {
    signed: root.signed ?? null,
    proof: 'all SSA phi predecessors committed the exact spilled value to one lvalue',
  });
}
''',
    "committed phi return recovery",
)
replace_once(
    "js/decompiler/passes/stack-return-recovery.js",
    r'''  const recovered = resolve(result.ir, ret.block, ret.row, root.location.key, values, opts, engine, new Set());
  if (!recovered || recovered.kind === 'load' || !rewriteReturn(result, recovered, opts)) return result;
''',
    r'''  const committed = committedReturnValue(result, root, ret);
  const recovered = committed || resolve(result.ir, ret.block, ret.row, root.location.key, values, opts, engine, new Set());
  // A stack load means no useful reconstruction happened. A committed non-stack
  // field/global load is an intentional high-level return and must be retained.
  if (!recovered || (recovered.kind === 'load' && recovered.location?.kind === 'stack') || !rewriteReturn(result, recovered, opts)) return result;
''',
    "prefer committed lvalue return",
)

# Strengthen the exact screenshot regression to include the two last failures.
replace_once(
    "tests/decompiler-semantic.mjs",
    r'''  assert.match(callLine.text, /^puts\([^,]+\);$/, callLine.text);
  assert.doesNotMatch(callLine.text, /\ba[234]\b/);

  const update = r.lines.find((l) => /self->hp\s*-=/.test(l.text));
''',
    r'''  assert.equal(callLine.text, 'puts("damage dealt to enemy");');
  assert.doesNotMatch(callLine.text, /\ba[234]\b/);
  assert.match(r.pseudocode, /return\s+self->hp;/);

  const update = r.lines.find((l) => /self->hp\s*-=/.test(l.text));
''',
    "exact string and return regression",
)
replace_once(
    "tests/decompiler-semantic.mjs",
    r'''  assert.equal(formatDecompilerSource(cond), '0004B0–0004B4');

  assert.equal(formatDecompilerSource({ source: { addresses: [0x1000004C4n, 0x1000004D4n, 0x1000004D8n, 0x1000004DCn] } }),
''',
    r'''  assert.equal(formatDecompilerSource(cond), '0004B0–0004B4');

  const zeroStore = r.lines.find((l) => /self->hp\s*=\s*0;/.test(l.text));
  assert.ok(zeroStore);
  assert.equal(formatDecompilerSource(zeroStore), '0004B8–0004C0');
  assert.equal(formatDecompilerSource(callLine), '0004C8–0004D0');
  const returnLine = r.lines.find((l) => /return\s+self->hp;/.test(l.text));
  assert.ok(returnLine);
  assert.equal(formatDecompilerSource(returnLine), '0004D4 · 0004DC');

  assert.equal(formatDecompilerSource({ source: { addresses: [0x1000004C4n, 0x1000004D4n, 0x1000004D8n, 0x1000004DCn] } }),
''',
    "exact per-statement provenance regression",
)

print("round2 correctness fixes applied")
