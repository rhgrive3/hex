from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def replace_once(rel, before, after, label):
    path = ROOT / rel
    text = path.read_text()
    count = text.count(before)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match in {rel}, found {count}")
    path.write_text(text.replace(before, after, 1))


# ---------------------------------------------------------------------------
# Semantic decompiler: preserve value/state semantics instead of re-rendering
# pre-store SSA expressions in post-store conditions; prove call arity; suppress
# compiler-only stack spills; attach exact multi-instruction provenance.
# ---------------------------------------------------------------------------
replace_once(
    "js/decompiler/semantic.js",
    "import { buildAppleRuntimeIndex, resolveAppleCall, shouldFoldRuntimeCall, runtimeOriginForSymbol } from '../apple/runtime.js';\n",
    "import { buildAppleRuntimeIndex, resolveAppleCall, shouldFoldRuntimeCall, runtimeOriginForSymbol } from '../apple/runtime.js';\n"
    "import { callArgumentIndices, knownCallPrototype } from './call-prototypes.js';\n"
    "import { sourceOf, mergeSource } from './ast/nodes.js';\n",
    "semantic imports",
)

replace_once(
    "js/decompiler/semantic.js",
    "function sameValue(a, b) { return !!a && !!b && a.id === b.id; }\n",
    r'''function sameValue(a, b) { return !!a && !!b && a.id === b.id; }

function sourceForInst(inst, reason = null) {
  if (!inst) return sourceOf();
  return sourceOf({
    address: inst.address ?? null, row: inst.row ?? null, ir: inst.id ?? null,
    evidence: reason ? [{ reason }] : [],
  });
}

function dependencySource(value, ctx, seen = new Set(), depth = 0) {
  if (!value || depth > MAX_EXPR_DEPTH || seen.has(value.id)) return sourceOf();
  seen.add(value.id);
  const d = value.def;
  if (!d) return sourceOf({ ssaUse: value.id });
  const parts = [sourceForInst(d), sourceOf({ ssaDef: value.id })];
  if (d.op === OP.PHI) {
    for (const incoming of d.incoming || []) parts.push(dependencySource(incoming.value, ctx, seen, depth + 1));
  } else if (d.op === OP.LOAD) {
    parts.push(dependencySource(d.addr?.base, ctx, seen, depth + 1));
    parts.push(dependencySource(d.addr?.index, ctx, seen, depth + 1));
  } else {
    for (const arg of d.args || []) parts.push(dependencySource(valueOf(arg), ctx, seen, depth + 1));
  }
  return mergeSource(...parts);
}

function controlSource(inst) {
  if (!inst) return sourceOf();
  const flags = valueOf(inst.args?.[inst.args.length - 1]);
  const cmp = cmpFromFlags(flags);
  return mergeSource(sourceForInst(cmp, cmp ? 'condition compare' : null), sourceForInst(inst, 'control transfer'));
}

function storeSource(inst, ctx) {
  return mergeSource(
    dependencySource(valueOf(inst.args?.[0]), ctx),
    dependencySource(inst.addr?.base, ctx),
    dependencySource(inst.addr?.index, ctx),
    sourceForInst(inst, 'memory store'),
  );
}

function callSource(inst, call, ctx) {
  const parts = [sourceForInst(inst, 'call')];
  for (const index of call?.sourceArgIndices || []) {
    parts.push(dependencySource(reachingRegisterValue(ctx.ir, inst, `x${index}`), ctx));
  }
  return mergeSource(...parts);
}

function buildStoredValueAliases(ir) {
  const out = new Map();
  for (const inst of ir?.instructions || []) {
    if (inst.op !== OP.STORE) continue;
    const value = valueOf(inst.args?.[0]);
    if (!value) continue;
    if (!out.has(value.id)) out.set(value.id, []);
    out.get(value.id).push(inst);
  }
  return out;
}

/*
 * Once `v = old_field - damage` has been committed by a STORE, a following CMP
 * of v is a comparison of the new field value. Re-expanding v as
 * `field - damage` after emitting `field -= damage` would apply the subtraction
 * twice in the source program. Alias it back to the committed lvalue only when
 * same-basic-block ordering and the absence of an intervening memory/call
 * barrier prove that substitution safe.
 */
function storedValueAlias(value, atInst, ctx) {
  if (!value || !atInst) return null;
  const stores = ctx.storedValueAliases?.get(value.id) || [];
  for (let n = stores.length - 1; n >= 0; n--) {
    const store = stores[n];
    if (store.block !== atInst.block || store.row == null || atInst.row == null || store.row >= atInst.row) continue;
    const blocked = (ctx.ir.blocks?.[atInst.block]?.insts || []).some((inst) =>
      inst.row > store.row && inst.row < atInst.row && (inst.op === OP.STORE || inst.op === OP.CALL || inst.op === OP.UNKNOWN));
    if (blocked) continue;
    return renderMemoryLocation(store.loc, store, ctx);
  }
  return null;
}

function renderValueAt(value, atInst, ctx) {
  return storedValueAlias(value, atInst, ctx) || renderValue(value, ctx);
}

function canonicalRegister(reg) {
  const text = String(reg || '').toLowerCase();
  const m = /^[wx](\d+)$/.exec(text);
  return m ? `r${m[1]}` : text;
}

function loadReachedByStore(load, store, ctx) {
  if (load?.op !== OP.LOAD || load.loc?.key !== store.loc?.key || load.row <= store.row) return false;
  if (load.reachingStore) return load.reachingStore === store;
  // Conservative linear fallback for older IR producers without a reachingStore
  // annotation. Cross-block cases require Memory SSA proof.
  if (load.block !== store.block) return false;
  return !(ctx.ir.blocks?.[load.block]?.insts || []).some((x) =>
    x.op === OP.STORE && x.loc?.key === store.loc?.key && x.row > store.row && x.row < load.row);
}

function feedsReturn(value, ctx) {
  if (!value || !ctx.returnInst) return false;
  const rv = reachingRegisterValue(ctx.ir, ctx.returnInst, 'x0') || valueOf(ctx.returnInst.args?.[0]);
  return sameValue(value, rv);
}

/* Hide only stack stores whose loads prove register preservation/return spill. */
function isMechanicalStackSpill(inst, ctx) {
  if (inst?.op !== OP.STORE || inst.loc?.kind !== MK.STACK) return false;
  const stored = valueOf(inst.args?.[0]);
  const reg = canonicalRegister(stored?.reg);
  if (reg === 'r29' || reg === 'r30') return true; // frame pointer / link register save
  const loads = (ctx.ir.instructions || []).filter((x) => loadReachedByStore(x, inst, ctx));
  if (!loads.length) return false;
  return loads.every((load) =>
    (reg && canonicalRegister(load.dst?.reg) === reg) || feedsReturn(load.dst, ctx));
}

function stringLiteralAt(addr, ctx) {
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
    "semantic provenance/state helpers",
)

replace_once(
    "js/decompiler/semantic.js",
    r'''function renderCmp(cmp, cond, ctx) {
  if (!cmp) return cond ? `condition_${cond}` : 'condition';
  const info = COND[cond] || null;
  const a = renderValue(valueOf(cmp.args?.[0]), ctx);
  const b = renderValue(valueOf(cmp.args?.[1]), ctx);
  if (!info) return `${a} /* ${cond || 'flags'} */`;
  if (info.vsZero) return `${a} ${info.op} 0`;
  return `${a} ${info.op} ${b}`;
}

export function renderBranchCondition(inst, ctx, invert = false) {
  if (!inst || inst.op !== OP.CBR) return 'condition';
  const kind = inst.extra?.kind || inst.sub || '';
  let s;
  if (kind === 'cbz' || kind === 'cbnz') {
    s = `${renderValue(valueOf(inst.args?.[0]), ctx)} ${kind === 'cbz' ? '==' : '!='} 0`;
  } else if (kind === 'tbz' || kind === 'tbnz') {
    const bit = inst.extra?.bit ?? 0;
    s = `((${renderValue(valueOf(inst.args?.[0]), ctx)} >> ${bit}) & 1) ${kind === 'tbz' ? '==' : '!='} 0`;
  } else {
    let cond = inst.cond || inst.extra?.cond || 'ne';
    if (invert) cond = inverseCondition(cond) || cond;
    const flags = valueOf(inst.args?.[inst.args.length - 1]);
    return renderCmp(cmpFromFlags(flags), cond, ctx);
  }
  return invert ? `!(${s})` : s;
}
''',
    r'''function renderCmp(cmp, cond, ctx, atInst = cmp) {
  if (!cmp) return cond ? `condition_${cond}` : 'condition';
  const info = COND[cond] || null;
  const a = renderValueAt(valueOf(cmp.args?.[0]), atInst, ctx);
  const b = renderValueAt(valueOf(cmp.args?.[1]), atInst, ctx);
  if (!info) return `${a} /* ${cond || 'flags'} */`;
  if (info.vsZero) return `${a} ${info.op} 0`;
  return `${a} ${info.op} ${b}`;
}

export function renderBranchCondition(inst, ctx, invert = false) {
  if (!inst || inst.op !== OP.CBR) return 'condition';
  const kind = inst.extra?.kind || inst.sub || '';
  let s;
  if (kind === 'cbz' || kind === 'cbnz') {
    s = `${renderValueAt(valueOf(inst.args?.[0]), inst, ctx)} ${kind === 'cbz' ? '==' : '!='} 0`;
  } else if (kind === 'tbz' || kind === 'tbnz') {
    const bit = inst.extra?.bit ?? 0;
    s = `((${renderValueAt(valueOf(inst.args?.[0]), inst, ctx)} >> ${bit}) & 1) ${kind === 'tbz' ? '==' : '!='} 0`;
  } else {
    let cond = inst.cond || inst.extra?.cond || 'ne';
    if (invert) cond = inverseCondition(cond) || cond;
    const flags = valueOf(inst.args?.[inst.args.length - 1]);
    return renderCmp(cmpFromFlags(flags), cond, ctx, inst);
  }
  return invert ? `!(${s})` : s;
}
''',
    "post-store condition rendering",
)

replace_once(
    "js/decompiler/semantic.js",
    r'''function callRecord(inst, ctx) {
  if (ctx.callCache.has(inst.id)) return ctx.callCache.get(inst.id);
  const target = inst.extra?.target ?? null;
  const modelCall = (ctx.model.calls || []).find((c) => c.row === inst.row) || null;
  const name = modelCall?.name || (target != null ? ctx.opts.symbolFor?.(target) : null) || inst.extra?.name || '';
  const values = [];
  for (let i = 0; i < 8; i++) values.push(reachingRegisterValue(ctx.ir, inst, 'x' + i));
  const argText = values.map((v) => v ? renderValue(v, ctx) : null);
  const origin = runtimeOriginForSymbol(name);
  let selector = null;
  let receiverType = null;
  if (origin === 'objc' || /objc_msgSend/.test(name)) {
    const selValue = values[1];
    const selAddr = selValue?.const ?? (selValue?.def?.op === OP.ADDR ? selValue.const : null);
    if (selAddr != null) selector = ctx.opts.selectorFor?.(selAddr) || ctx.runtime?.selectors?.byAddress?.get(selAddr.toString())?.[0]?.selector || null;
    receiverType = typeNameOf(ctx.types.values.get(values[0]?.id));
    if (receiverType === 'unknown' || receiverType === 'id' || receiverType === 'void *') receiverType = ctx.opts.receiverType || null;
  }
  const logicalArgs = origin === 'objc' || /objc_msgSend/.test(name) ? argText.slice(2).filter((x) => x != null) : argText.filter((x, i) => x != null && (modelCall?.args?.some?.((a) => a.index === i) || i < (ctx.opts.defaultCallArgs ?? 4)));
  const info = {
    name, target, runtime: origin, args: logicalArgs,
    receiver: argText[0] || 'receiver', receiverType, selector,
    stubAddress: target, callingConvention: ctx.opts.swiftCallingConventionFor?.(target, name) || null,
    kind: ctx.opts.swiftDispatchFor?.(inst)?.kind || (inst.extra?.indirect ? 'indirect' : 'direct'),
    ...(ctx.opts.swiftDispatchFor?.(inst) || {}),
  };
  const resolved = resolveAppleCall(ctx.runtime, info);
  const rec = { ...info, resolved };
  ctx.callCache.set(inst.id, rec);
  return rec;
}

function renderCall(inst, ctx) {
  const c = callRecord(inst, ctx);
  if (c.resolved.runtime === 'objc' && c.resolved.message) return c.resolved.message.text;
  if (c.resolved.runtime === 'swift' && c.resolved.text) return c.resolved.text;
  const name = c.name ? safeIdent(c.name, 'unknown_call') : null;
  if (name) return `${name}(${c.args.join(', ')})`;
  const targetValue = valueOf(inst.args?.[0]);
  return `unknown_call(${targetValue ? renderValue(targetValue, ctx) : ''})`;
}
''',
    r'''function callRecord(inst, ctx) {
  if (ctx.callCache.has(inst.id)) return ctx.callCache.get(inst.id);
  const target = inst.extra?.target ?? null;
  const modelCall = (ctx.model.calls || []).find((c) => c.row === inst.row) || null;
  const name = modelCall?.name || (target != null ? ctx.opts.symbolFor?.(target) : null) || inst.extra?.name || '';
  const values = [];
  for (let i = 0; i < 8; i++) values.push(reachingRegisterValue(ctx.ir, inst, 'x' + i));
  const argText = values.map((v) => v ? renderValue(v, ctx) : null);
  const origin = runtimeOriginForSymbol(name);
  const objc = origin === 'objc' || /objc_msgSend/.test(name);
  let selector = modelCall?.selector || null;
  let receiverType = null;
  if (objc) {
    const selValue = values[1];
    const selAddr = selValue?.const ?? (selValue?.def?.op === OP.ADDR ? selValue.const : null);
    if (!selector && selAddr != null) selector = ctx.opts.selectorFor?.(selAddr) || ctx.runtime?.selectors?.byAddress?.get(selAddr.toString())?.[0]?.selector || null;
    receiverType = typeNameOf(ctx.types.values.get(values[0]?.id));
    if (receiverType === 'unknown' || receiverType === 'id' || receiverType === 'void *') receiverType = ctx.opts.receiverType || null;
  }

  let logicalArgs = [];
  let sourceArgIndices = [];
  let arityKnown = true;
  let variadicPrefixOnly = false;
  if (objc) {
    const selectorArity = selector ? (selector.match(/:/g) || []).length : null;
    if (selectorArity == null) {
      arityKnown = false;
      sourceArgIndices = [0, 1].filter((i) => values[i]);
    } else {
      const indexes = Array.from({ length: selectorArity }, (_, i) => i + 2).filter((i) => i < 8);
      logicalArgs = indexes.map((i) => argText[i]).filter((x) => x != null);
      sourceArgIndices = [0, 1, ...indexes].filter((i) => values[i]);
    }
  } else {
    let override = null;
    try { override = ctx.opts.callPrototypeFor?.(target, name, inst) || null; } catch { override = null; }
    const indexes = callArgumentIndices({ name, modelCall, override, defaultCallArgs: ctx.opts.defaultCallArgs });
    if (indexes == null) {
      arityKnown = false;
      ctx.unknownCallArities++;
    } else {
      logicalArgs = indexes.map((i) => argText[i] ?? 'unknown');
      sourceArgIndices = indexes.filter((i) => values[i]);
      variadicPrefixOnly = !!knownCallPrototype(name)?.variadic && !override;
    }
  }

  const info = {
    name, target, runtime: origin, args: logicalArgs, arityKnown, variadicPrefixOnly, sourceArgIndices,
    receiver: argText[0] || 'receiver', receiverType, selector,
    stubAddress: target, callingConvention: ctx.opts.swiftCallingConventionFor?.(target, name) || null,
    kind: ctx.opts.swiftDispatchFor?.(inst)?.kind || (inst.extra?.indirect ? 'indirect' : 'direct'),
    ...(ctx.opts.swiftDispatchFor?.(inst) || {}),
  };
  const resolved = resolveAppleCall(ctx.runtime, info);
  const rec = { ...info, resolved };
  ctx.callCache.set(inst.id, rec);
  return rec;
}

function renderCall(inst, ctx) {
  const c = callRecord(inst, ctx);
  if (c.resolved.runtime === 'objc' && c.resolved.message) return c.resolved.message.text;
  if (c.resolved.runtime === 'swift' && c.resolved.text) return c.resolved.text;
  const name = c.name ? safeIdent(c.name, 'unknown_call') : null;
  if (name) {
    const args = !c.arityKnown ? '/* arguments unknown */'
      : c.args.join(', ') + (c.variadicPrefixOnly ? `${c.args.length ? ', ' : ''}/* varargs unknown */` : '');
    return `${name}(${args})`;
  }
  const targetValue = valueOf(inst.args?.[0]);
  return `unknown_call(${targetValue ? renderValue(targetValue, ctx) : '/* target unknown */'})`;
}
''',
    "evidence based call arity",
)

replace_once(
    "js/decompiler/semantic.js",
    r'''    } else if (d.op === OP.ADDR) {
      const addr = value.const ?? d.extra?.value ?? d.extra?.target;
      out = addr != null ? (ctx.opts.symbolFor?.(addr) ? safeIdent(ctx.opts.symbolFor(addr)) : `&global_${hex(addr)}`) : 'address_unknown';
    } else if (d.op === OP.CALL) out = renderCall(d, ctx);
''',
    r'''    } else if (d.op === OP.ADDR) {
      const addr = value.const ?? d.extra?.value ?? d.extra?.target;
      const literal = stringLiteralAt(addr, ctx);
      out = literal || (addr != null ? (ctx.opts.symbolFor?.(addr) ? safeIdent(ctx.opts.symbolFor(addr)) : `&global_${hex(addr)}`) : 'address_unknown');
    } else if (d.op === OP.CALL) out = renderCall(d, ctx);
''',
    "semantic string literals",
)

replace_once(
    "js/decompiler/semantic.js",
    r'''function emitBlockStatements(block, out, ctx, indent) {
  const term = blockTerm(block);
  for (const inst of block.insts || []) {
    if (inst === term || inst.op === OP.CMP || inst.op === OP.PHI || inst.op === OP.LOAD || inst.op === OP.CONST || inst.op === OP.MOV || inst.op === OP.BIN || inst.op === OP.UN || inst.op === OP.SEL || inst.op === OP.ADDR || inst.op === OP.MAC || inst.op === OP.BFX || inst.op === OP.BFI || inst.op === OP.CLOBBER) continue;
    if (inst.op === OP.STORE) {
      const text = statementForStore(inst, ctx);
      out.push(line('stmt', indent, text, inst.row, inst.address)); ctx.evidence.push(evidenceOf(inst, 'Memory SSA store'));
    } else if (inst.op === OP.CALL) {
      const c = callRecord(inst, ctx);
      if (shouldFoldRuntimeCall(c.name, { expert: ctx.opts.expert })) { ctx.suppressed.push(evidenceOf(inst, `folded runtime noise: ${c.name}`)); continue; }
      const call = renderCall(inst, ctx);
      if (inst.dst && ctx.materialNames.has(inst.dst.id)) out.push(line('stmt', indent, `${ctx.materialNames.get(inst.dst.id)} = ${call};`, inst.row, inst.address));
      else out.push(line('stmt', indent, `${call};`, inst.row, inst.address));
      ctx.evidence.push(evidenceOf(inst, c.resolved.runtime === 'objc' ? 'Objective-C dispatch' : c.resolved.runtime === 'swift' ? 'Swift dispatch' : 'call'));
    } else if (inst.op === OP.UNKNOWN) {
      out.push(line('stmt', indent, `__asm(${JSON.stringify(inst.text || 'unknown')});`, inst.row, inst.address)); ctx.unknown++;
      ctx.evidence.push(evidenceOf(inst, 'unsupported IR instruction retained faithfully'));
    }
  }
  return term;
}
''',
    r'''function emitBlockStatements(block, out, ctx, indent) {
  const term = blockTerm(block);
  for (const inst of block.insts || []) {
    if (inst === term || inst.op === OP.CMP || inst.op === OP.PHI || inst.op === OP.LOAD || inst.op === OP.CONST || inst.op === OP.MOV || inst.op === OP.BIN || inst.op === OP.UN || inst.op === OP.SEL || inst.op === OP.ADDR || inst.op === OP.MAC || inst.op === OP.BFX || inst.op === OP.BFI || inst.op === OP.CLOBBER) continue;
    if (inst.op === OP.STORE) {
      if (isMechanicalStackSpill(inst, ctx)) {
        ctx.suppressed.push(evidenceOf(inst, 'compiler-only stack spill'));
        continue;
      }
      const text = statementForStore(inst, ctx);
      out.push(line('stmt', indent, text, inst.row, inst.address, { source: storeSource(inst, ctx) }));
      ctx.evidence.push(evidenceOf(inst, 'Memory SSA store'));
    } else if (inst.op === OP.CALL) {
      const c = callRecord(inst, ctx);
      if (shouldFoldRuntimeCall(c.name, { expert: ctx.opts.expert })) { ctx.suppressed.push(evidenceOf(inst, `folded runtime noise: ${c.name}`)); continue; }
      const call = renderCall(inst, ctx);
      const extra = { source: callSource(inst, c, ctx) };
      if (inst.dst && ctx.materialNames.has(inst.dst.id)) out.push(line('stmt', indent, `${ctx.materialNames.get(inst.dst.id)} = ${call};`, inst.row, inst.address, extra));
      else out.push(line('stmt', indent, `${call};`, inst.row, inst.address, extra));
      ctx.evidence.push(evidenceOf(inst, c.resolved.runtime === 'objc' ? 'Objective-C dispatch' : c.resolved.runtime === 'swift' ? 'Swift dispatch' : 'call'));
    } else if (inst.op === OP.UNKNOWN) {
      out.push(line('stmt', indent, `__asm(${JSON.stringify(inst.text || 'unknown')});`, inst.row, inst.address, { source: sourceForInst(inst, 'unsupported instruction') })); ctx.unknown++;
      ctx.evidence.push(evidenceOf(inst, 'unsupported IR instruction retained faithfully'));
    }
  }
  return term;
}
''',
    "statement provenance and spill suppression",
)

replace_once(
    "js/decompiler/semantic.js",
    "  const lines = [line('ctrl', indent, `${head} {`, term.row, term.address)];\n",
    "  const lines = [line('ctrl', indent, `${head} {`, term.row, term.address, { source: controlSource(term) })];\n",
    "loop header provenance",
)
replace_once(
    "js/decompiler/semantic.js",
    "  lines.push(line('ctrl', indent, '}', term.row, term.address));\n",
    "  lines.push(line('ctrl', indent, '}'));\n",
    "synthetic loop brace provenance",
)

replace_once(
    "js/decompiler/semantic.js",
    r'''      if (structural) {
        const cond = renderBranchCondition(term2, ctx);
        out.push(line('ctrl', indent, `if (${cond}) {`, term2.row, term2.address));
        emitRegion(yes, join, out, ctx, state, indent + 1, allowed);
        out.push(line('ctrl', indent, '} else {'));
        emitRegion(no, join, out, ctx, state, indent + 1, allowed);
        out.push(line('ctrl', indent, '}'));
        bi = join; continue;
      }
      const cond = renderBranchCondition(term2, ctx);
      if (yes != null) out.push(line('ctrl', indent, `if (${cond}) goto loc_${hex(ctx.blockAddress(yes))};`, term2.row, term2.address));
''',
    r'''      if (structural) {
        const yesEmpty = yes === join;
        const noEmpty = no === join;
        if (yesEmpty !== noEmpty) {
          const invert = yesEmpty;
          const bodyStart = yesEmpty ? no : yes;
          const cond = renderBranchCondition(term2, ctx, invert);
          out.push(line('ctrl', indent, `if (${cond}) {`, term2.row, term2.address, { source: controlSource(term2) }));
          emitRegion(bodyStart, join, out, ctx, state, indent + 1, allowed);
          out.push(line('ctrl', indent, '}'));
        } else {
          const cond = renderBranchCondition(term2, ctx);
          out.push(line('ctrl', indent, `if (${cond}) {`, term2.row, term2.address, { source: controlSource(term2) }));
          emitRegion(yes, join, out, ctx, state, indent + 1, allowed);
          out.push(line('ctrl', indent, '} else {'));
          emitRegion(no, join, out, ctx, state, indent + 1, allowed);
          out.push(line('ctrl', indent, '}'));
        }
        bi = join; continue;
      }
      const cond = renderBranchCondition(term2, ctx);
      if (yes != null) out.push(line('ctrl', indent, `if (${cond}) goto loc_${hex(ctx.blockAddress(yes))};`, term2.row, term2.address, { source: controlSource(term2) }));
''',
    "empty branch inversion and provenance",
)

replace_once(
    "js/decompiler/semantic.js",
    "        out.push(line('ctrl', indent, `switch (${expr}) {`, term2.row, term2.address));\n",
    "        out.push(line('ctrl', indent, `switch (${expr}) {`, term2.row, term2.address, { source: controlSource(term2) }));\n",
    "switch provenance",
)
replace_once(
    "js/decompiler/semantic.js",
    "      out.push(line('stmt', indent, text, term2.row, term2.address)); ctx.evidence.push(evidenceOf(term2, 'return')); return;\n",
    "      out.push(line('stmt', indent, text, term2.row, term2.address, { source: mergeSource(dependencySource(rv, ctx), sourceForInst(term2, 'return')) })); ctx.evidence.push(evidenceOf(term2, 'return')); return;\n",
    "structured return provenance",
)
replace_once(
    "js/decompiler/semantic.js",
    "      if (yes != null) out.push(line('ctrl', indent + 1, `if (${renderBranchCondition(term, ctx)}) goto loc_${hex(ctx.blockAddress(yes))};`, term.row, term.address));\n",
    "      if (yes != null) out.push(line('ctrl', indent + 1, `if (${renderBranchCondition(term, ctx)}) goto loc_${hex(ctx.blockAddress(yes))};`, term.row, term.address, { source: controlSource(term) }));\n",
    "faithful condition provenance",
)
replace_once(
    "js/decompiler/semantic.js",
    "      out.push(line('stmt', indent + 1, rv ? `return ${renderValue(rv, ctx)};` : 'return;', term.row, term.address));\n",
    "      out.push(line('stmt', indent + 1, rv ? `return ${renderValue(rv, ctx)};` : 'return;', term.row, term.address, { source: mergeSource(dependencySource(rv, ctx), sourceForInst(term, 'return')) }));\n",
    "faithful return provenance",
)

replace_once(
    "js/decompiler/semantic.js",
    r'''    rmwByStore: new Map(rmw.map((r) => [r.store.id, r])),
    exprCache: new Map(), exprActive: new Set(), exprNodes: 0,
    callCache: new Map(), evidence: [], suppressed: [], unknown: 0,
''',
    r'''    rmwByStore: new Map(rmw.map((r) => [r.store.id, r])),
    storedValueAliases: buildStoredValueAliases(ir),
    returnInst: [...(ir.instructions || [])].reverse().find((i) => i.op === OP.RET) || null,
    exprCache: new Map(), exprActive: new Set(), exprNodes: 0,
    callCache: new Map(), evidence: [], suppressed: [], unknown: 0, unknownCallArities: 0,
''',
    "semantic context state",
)

replace_once(
    "js/decompiler/semantic.js",
    r'''  const lines = [line('sig', 0, signature, model.instructions?.[0]?.row ?? null, firstAddr), line('ctrl', 0, '{', model.instructions?.[0]?.row ?? null)];
  for (const l of body) lines.push(l);
  lines.push(line('ctrl', 0, '}', model.instructions?.at?.(-1)?.row ?? null));
''',
    r'''  const lines = [
    line('sig', 0, signature, model.instructions?.[0]?.row ?? null, firstAddr, { source: sourceOf({ address: firstAddr, row: model.instructions?.[0]?.row ?? null, evidence: [{ reason: 'function entry' }] }) }),
    line('ctrl', 0, '{'),
  ];
  for (const l of body) lines.push(l);
  lines.push(line('ctrl', 0, '}'));
''',
    "synthetic function brace provenance",
)
replace_once(
    "js/decompiler/semantic.js",
    "  if (ctx.unknown) warnings.push(`${ctx.unknown} unsupported IR instruction(s) remain as __asm.`);\n",
    "  if (ctx.unknown) warnings.push(`${ctx.unknown} unsupported IR instruction(s) remain as __asm.`);\n  if (ctx.unknownCallArities) warnings.push(`${ctx.unknownCallArities} call site(s) have unknown arity; live argument registers were intentionally not guessed.`);\n",
    "unknown call arity warning",
)

# ---------------------------------------------------------------------------
# Typed AST pipeline: do not collapse semantic source sets back to one address.
# Compound stores include the expression-defining instructions plus the STORE;
# returns include the value materialization plus RET.
# ---------------------------------------------------------------------------
replace_once(
    "js/decompiler/pipeline-core.js",
    "    return { text, semantic: { op: 'store', location, expression: e, ir: store.id }, source: origin(store, store.dst) };\n",
    "    return { text, semantic: { op: 'store', location, expression: e, ir: store.id }, source: mergeSource(e?.source, origin(store, store.dst)) };\n",
    "typed store provenance",
)
replace_once(
    "js/decompiler/pipeline-core.js",
    "    if (rv) return { text: `return ${printExpression(expressionFor(rv, state))};`, semantic: { op: 'return', expression: expressionFor(rv, state), ir: ret.id }, source: origin(ret, rv) };\n",
    "    if (rv) { const e = expressionFor(rv, state); return { text: `return ${printExpression(e)};`, semantic: { op: 'return', expression: e, ir: ret.id }, source: mergeSource(e?.source, origin(ret, rv)) }; }\n",
    "typed return provenance",
)
replace_once(
    "js/decompiler/pipeline-core.js",
    "    const source = known?.source || sourceOf({ address: line.addr, row: line.row, evidence: line.note ? [{ reason: line.note }] : [] });\n",
    r'''    const carried = line.source || { address: line.addr, row: line.row };
    const source = known?.source || sourceOf({
      ...carried,
      evidence: [...(carried.evidence || []), ...(line.note ? [{ reason: line.note }] : [])],
    });
''',
    "preserve line source sets",
)

# ---------------------------------------------------------------------------
# UI: show exact source ranges/sets, expand all contributing assembly rows, and
# never offer an ambiguous single-instruction patch for a multi-instruction C
# statement. Also navigate call reports to the callee, not the call-site.
# ---------------------------------------------------------------------------
replace_once(
    "js/tools.js",
    "import { decompile, decompiledText } from './decompile.js';\n",
    "import { decompile, decompiledText } from './decompile.js';\nimport { decompilerSourceRows, formatDecompilerSource, fullDecompilerSourceText, hasSingleDecompilerInstruction, primaryDecompilerAddress } from './decompiler/provenance.js';\n",
    "tools provenance import",
)

replace_once(
    "js/tools.js",
    r'''  function render() {
    codeWrap.replaceChildren();
    for (const l of out.lines) {
      if (l.kind === 'blank') { codeWrap.append(el('div', 'cl blank', ' ')); continue; }
      const row = el('div', 'cl ' + l.kind);
      const gutter = el('span', 'cl-addr mono', l.addr != null ? l.addr.toString(16).toUpperCase().slice(-6) : '');
      const text = el('span', 'cl-text mono');
      paintCode(text, '    '.repeat(Math.max(0, l.indent)) + l.text);
      row.append(gutter, text);
      if (l.addr != null) {
        row.classList.add('tappable');
        row.addEventListener('click', () => lineMenu(app, sheet, l, byRow.get(l.row)));
      }
      codeWrap.append(row);
      if (showNotes && l.note) {
        const n = el('div', 'cl note');
        n.append(el('span', 'cl-addr'), el('span', 'cl-text', '// ' + l.note));
        codeWrap.append(n);
      }
      if (showAsm && l.row != null && byRow.has(l.row)) {
        const insn = byRow.get(l.row);
        const a = el('div', 'cl asm');
        a.append(el('span', 'cl-addr'), el('span', 'cl-text mono', '; ' + insn.mnemonic + ' ' + insn.operands));
        codeWrap.append(a);
      }
    }
  }
''',
    r'''  function render() {
    codeWrap.replaceChildren();
    for (const l of out.lines) {
      if (l.kind === 'blank') { codeWrap.append(el('div', 'cl blank', ' ')); continue; }
      const sourceRows = decompilerSourceRows(l);
      const sourceInsns = sourceRows.map((r) => byRow.get(r)).filter(Boolean);
      const primary = primaryDecompilerAddress(l);
      const row = el('div', 'cl ' + l.kind);
      const gutter = el('span', 'cl-addr mono', formatDecompilerSource(l, { maxGroups: 1 }));
      const text = el('span', 'cl-text mono');
      paintCode(text, '    '.repeat(Math.max(0, l.indent)) + l.text);
      row.append(gutter, text);
      if (primary != null) {
        row.classList.add('tappable');
        row.title = fullDecompilerSourceText(l);
        row.addEventListener('click', () => lineMenu(app, sheet, l, sourceInsns));
      }
      codeWrap.append(row);
      if (showNotes && l.note) {
        const n = el('div', 'cl note');
        n.append(el('span', 'cl-addr'), el('span', 'cl-text', '// ' + l.note));
        codeWrap.append(n);
      }
      if (showAsm) {
        for (const insn of sourceInsns) {
          const a = el('div', 'cl asm');
          const asmAddr = insn.address != null ? insn.address.toString(16).toUpperCase().slice(-6).padStart(6, '0') : '';
          a.append(el('span', 'cl-addr mono', asmAddr), el('span', 'cl-text mono', '; ' + insn.mnemonic + ' ' + insn.operands));
          codeWrap.append(a);
        }
      }
    }
  }
''',
    "decompiler multi-source rendering",
)

replace_once(
    "js/tools.js",
    r'''function lineMenu(app, sheet, line, insn) {
  const items = [
    { label: 'この場所へ移動', action: () => { sheet.close(); app.goToAddress(line.addr, { announce: true }); } },
    { label: 'アドレスをコピー', action: () => copyText(addrHex(line.addr), 'アドレス') },
  ];
  /*
   * 行の中では std::string::append まで短くしている。
   * 本当の名前（テンプレート引数まで入った形）は、ここから見られるようにする。
   */
  const callTarget = insn && insn.callTarget != null ? insn.callTarget : null;
  const raw = callTarget != null && app.symbols ? app.symbols.nameAt(callTarget) : null;
  if (raw && isMangled(raw)) {
    items.push({ label: 'この名前の元の形を見る', action: () => showRealName(raw) });
  }
  if (insn) {
    items.push({ label: 'この行を書き換える（パッチ）', action: () => showPatchEditor(app, line.addr, insn) });
    items.push({ label: 'メモを書く', action: () => showComment(app, line.addr) });
  }
  const called = /(\w+)\(/.exec(line.text);
  if (called) {
    items.push({
      label: '呼んでいる相手を調べる',
      action: () => { sheet.close(); app.openFunctionReport(line.addr); },
    });
  }
  menu(items, window.innerWidth / 2, window.innerHeight / 2);
}
''',
    r'''function lineMenu(app, sheet, line, sourceInsns = []) {
  const primary = primaryDecompilerAddress(line);
  if (primary == null) return;
  const items = [
    { label: '対応する先頭命令へ移動', action: () => { sheet.close(); app.goToAddress(primary, { announce: true }); } },
    { label: '対応する命令アドレスをコピー', action: () => copyText(fullDecompilerSourceText(line), '命令アドレス') },
  ];
  const callInsn = sourceInsns.find((x) => x?.isCall || x?.callTarget != null) || null;
  const callTarget = callInsn?.callTarget ?? null;
  const raw = callTarget != null && app.symbols ? app.symbols.nameAt(callTarget) : null;
  if (raw && isMangled(raw)) {
    items.push({ label: 'この名前の元の形を見る', action: () => showRealName(raw) });
  }
  if (hasSingleDecompilerInstruction(line) && sourceInsns.length === 1) {
    items.push({ label: 'この命令を書き換える（パッチ）', action: () => showPatchEditor(app, primary, sourceInsns[0]) });
    items.push({ label: 'メモを書く', action: () => showComment(app, primary) });
  } else if (sourceInsns.length) {
    items.push({ label: '先頭命令にメモを書く', action: () => showComment(app, primary) });
  }
  if (callTarget != null) {
    items.push({
      label: '呼んでいる相手を調べる',
      action: () => { sheet.close(); app.openFunctionReport(callTarget); },
    });
  }
  menu(items, window.innerWidth / 2, window.innerHeight / 2);
}
''',
    "source-aware line menu",
)

replace_once(
    "css/app.css",
    r'''.cl-addr {
  flex: 0 0 auto; width: 6ch;
  color: var(--code-addr); font-size: 10.5px;
  text-align: right; user-select: none;
}
''',
    r'''.cl-addr {
  flex: 0 0 auto; width: 13ch;
  color: var(--code-addr); font-size: 10.5px;
  text-align: right; user-select: none;
}
''',
    "wider source provenance gutter",
)

# ---------------------------------------------------------------------------
# Regression coverage: exact 20-instruction screenshot layout, call arity, stack
# spills, stateful branch semantics, strings, and sparse/contiguous provenance.
# ---------------------------------------------------------------------------
replace_once(
    "tests/decompiler-semantic.mjs",
    "import { buildSemanticModel } from '../js/blocks.js';\n",
    "import { buildSemanticModel, attachTexts } from '../js/blocks.js';\n",
    "test attachTexts import",
)
replace_once(
    "tests/decompiler-semantic.mjs",
    "import { inferSemanticTypes } from '../js/types.js';\n",
    "import { inferSemanticTypes } from '../js/types.js';\nimport { decompilerSourceAddresses, formatDecompilerSource, fullDecompilerSourceText } from '../js/decompiler/provenance.js';\n",
    "test provenance import",
)
replace_once(
    "tests/decompiler-semantic.mjs",
    r'''const BASE = 0x100000000n;
function make(lines) {
  const raw = lines.map((text, row) => {
    const p = text.indexOf(' ');
    return { row, address: BASE + BigInt(row * 4), mn: p < 0 ? text : text.slice(0, p), ops: p < 0 ? '' : text.slice(p + 1) };
  });
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - BASE;
    return d >= 0n && d < BigInt(raw.length * 4) ? Number(d / 4n) : null;
  };
  const model = buildSemanticModel(raw, { startRow: 0, endRow: raw.length - 1, rowOfAddress, symbolFor: () => null });
  return { raw, rowOfAddress, model };
}
''',
    r'''const BASE = 0x100000000n;
function make(lines, opts = {}) {
  const base = opts.base ?? BASE;
  const raw = lines.map((text, row) => {
    const p = text.indexOf(' ');
    return { row, address: base + BigInt(row * 4), mn: p < 0 ? text : text.slice(0, p), ops: p < 0 ? '' : text.slice(p + 1) };
  });
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - base;
    return d >= 0n && d < BigInt(raw.length * 4) ? Number(d / 4n) : null;
  };
  const model = buildSemanticModel(raw, {
    startRow: 0, endRow: raw.length - 1, rowOfAddress,
    symbolFor: opts.symbolFor || (() => null), name: opts.name || null,
  });
  return { raw, rowOfAddress, model, base };
}
''',
    "test helper options",
)

append_anchor = "// PHI induction must be detected from SSA rather than address-order guesses.\n"
append_test = r'''// Exact apply_damage screenshot regression: 20 ARM64 instructions at 0x100000490..4DC.
{
  const base = 0x100000490n;
  const PUTS = 0x100001000n;
  const { model, rowOfAddress } = make([
    'stp x29, x30, [sp, #-32]!',
    'mov x29, sp',
    'str x0, [sp, #16]',
    'ldr w8, [x0, #0x20]',
    'ldr w9, [x0, #0x24]',
    'mul w9, w1, w9',
    'sub w8, w8, w9',
    'str w8, [x0, #0x20]',
    'cmp w8, #0',
    'b.gt #0x1000004C4',
    'mov w8, #0',
    'ldr x0, [sp, #16]',
    'str w8, [x0, #0x20]',
    'str w8, [sp, #12]',
    'adrp x0, #0x100000000',
    'add x0, x0, #0x5B4',
    `bl #0x${PUTS.toString(16)}`,
    'ldr w0, [sp, #12]',
    'ldp x29, x30, [sp], #32',
    'ret',
  ], { base, name: 'apply_damage', symbolFor: (addr) => BigInt(addr) === PUTS ? '_puts' : null });
  attachTexts(model, new Map([['4294968756', 'damage dealt to enemy']])); // 0x1000005B4

  const r = decompile(model, {
    addr: base, name: 'apply_damage', rowOfAddress, receiverType: 'Unit', beginner: false,
    symbolFor: (addr) => BigInt(addr) === PUTS ? '_puts' : null,
    fieldFor: (_base, off) => off === 0x20n ? { name: 'hp', type: 'int32' }
      : off === 0x24n ? { name: 'damageRate', type: 'uint32' } : null,
  });
  assert.equal(r.semantic, true, r.warnings?.join('\n'));
  assert.equal(r.legacyFallback, undefined);
  assert.doesNotMatch(r.pseudocode, /\b(?:var_|local_phi|phi_)\w*/i, r.pseudocode);
  assert.match(r.pseudocode, /self->hp\s*-=\s*a2\s*\*\s*self->damageRate/);
  assert.match(r.pseudocode, /if\s*\(\s*self->hp\s*<=\s*0\s*\)/);
  assert.doesNotMatch(r.pseudocode, /if\s*\([^\n]*self->hp\s*-\s*[^\n]*damageRate/, r.pseudocode);
  assert.doesNotMatch(r.pseudocode, /if\s*\([^\n]+\)\s*\{\s*\}\s*else/s, r.pseudocode);

  const callLine = r.lines.find((l) => /\bputs\(/.test(l.text));
  assert.ok(callLine, r.pseudocode);
  assert.match(callLine.text, /^puts\([^,]+\);$/, callLine.text);
  assert.doesNotMatch(callLine.text, /\ba[234]\b/);

  const update = r.lines.find((l) => /self->hp\s*-=/.test(l.text));
  assert.ok(update, r.pseudocode);
  const updateAddrs = decompilerSourceAddresses(update);
  for (const addr of [0x10000049Cn, 0x1000004A0n, 0x1000004A4n, 0x1000004A8n, 0x1000004ACn]) {
    assert.ok(updateAddrs.includes(addr), `${addr.toString(16)} missing from ${fullDecompilerSourceText(update)}`);
  }
  assert.equal(formatDecompilerSource(update), '00049C–0004AC');

  const cond = r.lines.find((l) => /if\s*\(/.test(l.text));
  assert.ok(cond);
  assert.ok(decompilerSourceAddresses(cond).includes(0x1000004B0n), fullDecompilerSourceText(cond));
  assert.ok(decompilerSourceAddresses(cond).includes(0x1000004B4n), fullDecompilerSourceText(cond));
  assert.equal(formatDecompilerSource(cond), '0004B0–0004B4');

  assert.equal(formatDecompilerSource({ source: { addresses: [0x1000004C4n, 0x1000004D4n, 0x1000004D8n, 0x1000004DCn] } }),
    '0004C4 · 0004D4–0004DC');
}

'''
replace_once(
    "tests/decompiler-semantic.mjs",
    append_anchor,
    append_test + append_anchor,
    "apply_damage regression",
)

print("address provenance / semantic-state fix applied")
