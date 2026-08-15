from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    n = text.count(old)
    if n != 1:
        raise SystemExit(f'{path}: expected one match, got {n}')
    p.write_text(text.replace(old, new, 1))


replace_once('js/ir-core.js',
"""  if (insn.isCall) {
    const result = callResultLocation(insn, opts);
    push({
      op: OP.CALL,
      target: insn.callTarget != null ? insn.callTarget : null,
      indirect: insn.callTarget == null,
      srcs: (insn.callTarget == null && ops[0] && ops[0].k === 'reg')
        ? [{ t: 'reg', reg: regKeyOf(ops[0]), bits: 64 }] : [],
      dstReg: result?.reg || null, dstBits: result?.bits || 64,
      returnEvidence: result ? 'prototype' : null,
      clobbers: CALL_CLOBBERS,
    });
    return out;
  }""",
"""  if (insn.isCall) {
    const result = callResultLocation(insn, opts);
    // AAPCS64 integer/pointer arguments are live in x0-x7 at the call boundary.
    // Unknown prototypes intentionally keep all eight uses: conservative liveness
    // is required for pointer escape and PHI correctness.
    const callSrcs = Array.from({ length: 8 }, (_, i) => ({ t: 'reg', reg: `x${i}`, bits: 64 }));
    if (insn.callTarget == null && ops[0] && ops[0].k === 'reg') {
      const targetReg = regKeyOf(ops[0]);
      if (targetReg && !callSrcs.some((s) => s.reg === targetReg)) callSrcs.push({ t: 'reg', reg: targetReg, bits: 64 });
    }
    push({
      op: OP.CALL,
      target: insn.callTarget != null ? insn.callTarget : null,
      indirect: insn.callTarget == null,
      srcs: callSrcs,
      dstReg: result?.reg || null, dstBits: result?.bits || 64,
      returnEvidence: result ? 'prototype' : null,
      clobbers: CALL_CLOBBERS,
    });
    return out;
  }""")

replace_once('js/ir-core.js',
"""function buildMemorySSA(ir, df, idom, children) {""",
"""export function stackPointerProvenanceOf(value, memo = new Map(), active = new Set()) {
  if (!value) return null;
  if (memo.has(value.id)) return memo.get(value.id);
  if (active.has(value.id)) return null;
  active.add(value.id);
  let out = null;
  const reg = String(value.reg || '');
  const def = value.def;
  if (value.kind === VK.ARG && (reg === 'sp' || reg === 'x29')) {
    out = { offset: 0n, must: true, via: 'root' };
  } else if (def?.op === OP.MOV && def.args?.[0]?.value) {
    const p = stackPointerProvenanceOf(def.args[0].value, memo, active);
    if (p) out = { ...p, via: 'mov' };
  } else if (def?.op === OP.PHI && def.args?.length) {
    const incoming = def.args.map((a) => stackPointerProvenanceOf(a?.value, memo, active));
    const stackIncoming = incoming.filter(Boolean);
    if (stackIncoming.length) {
      const first = stackIncoming[0].offset;
      out = {
        offset: stackIncoming.every((p) => p.offset === first) ? first : null,
        must: stackIncoming.length === incoming.length && stackIncoming.every((p) => p.must !== false),
        via: 'phi',
      };
    }
  } else if (def?.op === OP.BIN && (def.sub === 'add' || def.sub === 'sub') && def.args?.length >= 2) {
    const left = def.args[0], right = def.args[1];
    const lc = left?.value?.const, rc = right?.value?.const;
    if (rc != null && left?.value) {
      const p = stackPointerProvenanceOf(left.value, memo, active);
      if (p) out = { ...p, offset: p.offset == null ? null : p.offset + (def.sub === 'sub' ? -rc : rc), via: def.sub };
    } else if (def.sub === 'add' && lc != null && right?.value) {
      const p = stackPointerProvenanceOf(right.value, memo, active);
      if (p) out = { ...p, offset: p.offset == null ? null : p.offset + lc, via: 'add' };
    }
  }
  active.delete(value.id);
  memo.set(value.id, out);
  return out;
}

function buildMemorySSA(ir, df, idom, children) {""")

replace_once('js/ir-core.js',
"""  /*
   * スタックのうち「アドレスを外へ渡していない」ものは、呼び出しで壊れない。
   * add x0, sp, #0x18 のように番地そのものを作って渡していたら、そこは壊れる。
   */
  const escapedStack = new Set();
  for (const inst of ir.instructions) {
    if (inst.op !== OP.BIN || inst.sub !== 'add') continue;
    const baseArg = inst.args[0];
    if (!baseArg || !baseArg.value) continue;
    if (baseArg.value.reg !== 'sp' && baseArg.value.reg !== 'x29') continue;
    const uses = inst.dst ? inst.dst.uses : [];
    if (uses.some((u) => u.op === OP.CALL || u.op === OP.STORE || u.op === OP.UNKNOWN)) {
      escapedStack.add('*');
    }
  }

  // 呼び出しは、スタック以外のすべてと、番地が漏れたスタックを壊す
""",
"""  /* Stack pointers may flow through ADD/SUB constants, MOV, and PHI before
   * crossing an opaque boundary. Follow SSA provenance instead of only direct
   * uses of the original ADD result. A may-stack PHI is sufficient to escape. */
  const stackPointerMemo = new Map();
  let stackEscaped = false;
  for (const inst of ir.instructions) {
    if (inst.op !== OP.CALL && inst.op !== OP.STORE && inst.op !== OP.UNKNOWN) continue;
    // STORE args are stored values; address operands live in inst.addr and are
    // intentionally excluded so an ordinary local store is not an escape.
    if ((inst.args || []).some((a) => stackPointerProvenanceOf(a?.value, stackPointerMemo))) {
      stackEscaped = true;
      break;
    }
  }

  // Calls/unknown effects clobber stack state only after a proven/may escape.
""")

replace_once('js/ir-core.js',
"""      if (loc.kind === MK.STACK && !escapedStack.has('*')) continue;""",
"""      if (loc.kind === MK.STACK && !stackEscaped) continue;""")

replace_once('package.json',
"""\"semantic:test\": \"node tests/ir-dataflow.mjs && node tests/ir-alias.mjs && node tests/ir-pinpoint-path.mjs""",
"""\"semantic:test\": \"node tests/issue-430-memory-escape.mjs && node tests/ir-dataflow.mjs && node tests/ir-alias.mjs && node tests/ir-pinpoint-path.mjs""")
