from pathlib import Path
import json


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, got {count}")
    return text.replace(old, new, 1)


# #460 report completeness now belongs behind #484's certainty facade.
p = Path("js/report-legacy.js")
s = p.read_text()
s = replace_once(s,
    "    if (!callers.length) facts.push(fact('no-callers', null));",
    "    if (!callers.length && program.statsComplete === true) facts.push(fact('no-callers', null));",
    "report no-callers")
s = replace_once(s,
    "  if (program && !program.statsComplete) unknowns.push(unknown('stats-partial', null));",
    "  if (program && !program.statsComplete) {\n    unknowns.push(unknown('stats-partial', null));\n    unknowns.push(unknown('callers-partial', { reason: 'program-index-incomplete', observed: callers.length }));\n  }",
    "report partial callers")
s = replace_once(s,
    "  if (callers.length) nextSteps.push({ code: 'check-callers', detail: { n: callers.length } });\n  else nextSteps.push({ code: 'no-callers-hint', detail: null });",
    "  if (callers.length) nextSteps.push({ code: 'check-callers', detail: { n: callers.length } });\n  else if (program && program.statsComplete !== true) nextSteps.push({ code: 'check-callers-incomplete', detail: { reason: 'program-index-incomplete' } });\n  else nextSteps.push({ code: 'no-callers-hint', detail: null });",
    "report next-step")
p.write_text(s)


# Preserve latest schema hardening and add #449's provenance-coherent table grouping.
p = Path("js/schema.js")
s = p.read_text()
marker = "function plainAccess(w) {\n  const m = W.memoryAccess(w);\n  if (!m || m.indexed || m.pair || m.disp == null) return null;\n  return { load: m.load, size: m.size, base: m.base, disp: Number(m.disp), reg: m.reg };\n}\n"
addition = marker + "\nfunction writtenGpr(w) {\n  const pcRel = W.pcRelTarget(w, 0n);\n  if (pcRel) return pcRel.reg;\n  const mw = moveWide(w);\n  if (mw) return mw.d;\n  const kind = W.classifyWord(w);\n  if ([W.KIND.MOVREG, W.KIND.ARITH, W.KIND.MUL, W.KIND.DIV, W.KIND.LOGIC, W.KIND.SHIFT, W.KIND.CSEL].includes(kind)) return rd(w);\n  if ((kind === W.KIND.LOAD || kind === W.KIND.LITERAL) && ((w >>> 26) & 1) === 0) return rd(w);\n  return null;\n}\n"
s = replace_once(s, marker, addition, "schema writtenGpr")
s = replace_once(s,
    "  const flow = controlContext(words, base);\n  let lastCall = -1;",
    "  const flow = controlContext(words, base);\n  const baseGeneration = new Uint32Array(32);\n  let lastCall = -1;",
    "schema base generations")
s = replace_once(s,
    "  for (let i = 0; i < words.length; i++) {\n    const w = words[i];\n    const mw = moveWide(w);",
    "  for (let i = 0; i < words.length; i++) {\n    const w = words[i];\n    const written = writtenGpr(w);\n    if (written != null && written >= 0 && written < 31) baseGeneration[written]++;\n    const mw = moveWide(w);",
    "schema generation updates")
s = replace_once(s,
    "      for (let r = 0; r <= 18; r++) known[r] = 0;",
    "      for (let r = 0; r <= 18; r++) { known[r] = 0; baseGeneration[r]++; }",
    "schema call clobbers")
s = replace_once(s,
    "        fixed.push({ row: i, addr: base + BigInt(i * 4), base: pa.base, disp: pa.disp, size: pa.size });",
    "        fixed.push({\n          row: i, addr: base + BigInt(i * 4), base: pa.base, disp: pa.disp, size: pa.size,\n          block: flow.blockOf[i], loop: flow.loopOf[i], baseGeneration: baseGeneration[pa.base],\n          fromCall: true, callRow: lastCall, callAddr: base + BigInt(lastCall * 4),\n        });",
    "schema fixed provenance")
helper = """function fixedRegion(f) {
  if (f?.loop != null && f.loop >= 0) return `loop:${f.loop}`;
  if (f?.block != null && f.block >= 0) return `block:${f.block}`;
  return null;
}

function splitLocalRuns(list, maxGap = 16) {
  const sorted = list.slice().sort((a, b) => a.row - b.row);
  const runs = [];
  let run = [];
  for (const item of sorted) {
    if (run.length && item.row - run[run.length - 1].row > maxGap) { runs.push(run); run = []; }
    run.push(item);
  }
  if (run.length) runs.push(run);
  return runs;
}

export function unrolledTablesFromFixed(fixed) {
  const groups = new Map();
  for (const f of fixed || []) {
    const region = fixedRegion(f);
    if (!region || f.base == null || f.baseGeneration == null || f.callRow == null || f.fromCall !== true) continue;
    const key = `${region}:x${f.base}:v${f.baseGeneration}:s${f.size}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const tables = [];
  for (const list of groups.values()) {
    for (const run of splitLocalRuns(list)) {
      if (run.length < 3) continue;
      const sorted = run.slice().sort((a, b) => a.row - b.row);
      const offsets = sorted.map((f) => f.disp);
      const stride = offsets[1] - offsets[0];
      if (!(stride > 0) || offsets.some((off, i) => i > 0 && off - offsets[i - 1] !== stride)) continue;
      if (new Set(offsets).size !== offsets.length) continue;
      const region = fixedRegion(sorted[0]);
      tables.push({
        kind: 'unrolled', columns: offsets.length, columnStride: stride, columnSize: sorted[0].size,
        recordStride: null, records: null, consistent: true, fromCall: true,
        storeAddr: sorted[0].addr, offsets, scaled: [],
        provenance: {
          base: sorted[0].base, baseGeneration: sorted[0].baseGeneration, region,
          callRows: sorted.map((f) => f.callRow), callAddrs: sorted.map((f) => f.callAddr ?? null),
          storeRows: sorted.map((f) => f.row),
        },
        offsetOf(i) { return i >= 0 && i < offsets.length ? offsets[i] : null; },
      });
    }
  }
  return tables;
}

"""
s = replace_once(s, "function buildSchema({ loops, fixed, scales, cmps, bumped, base }) {", helper + "function buildSchema({ loops, fixed, scales, cmps, bumped, base }) {", "schema unrolled helpers")
old_group = """  const byBase = new Map();
  for (const f of fixed) {
    if (!byBase.has(f.base)) byBase.set(f.base, []);
    byBase.get(f.base).push(f);
  }
  for (const list of byBase.values()) {
    if (list.length < 3) continue;
    const sorted = list.slice().sort((a, b) => a.row - b.row);
    const offsets = sorted.map((f) => f.disp);
    tables.push({ kind: 'unrolled', columns: offsets.length, columnStride: null, columnSize: sorted[0].size, recordStride: null, records: null, consistent: null, storeAddr: sorted[0].addr, offsets, scaled: [], offsetOf(i) { return i >= 0 && i < offsets.length ? offsets[i] : null; } });
  }
"""
s = replace_once(s, old_group, "  tables.push(...unrolledTablesFromFixed(fixed));\n", "schema unrolled grouping")
p.write_text(s)


# Preserve #484's Memory-SSA range hardening while porting #442's full
# SSA-provenance stack escape tracking and conservative call argument liveness.
p = Path("js/ir-core.js")
s = p.read_text()
old_call = """  if (insn.isCall) {
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
  }
"""
new_call = """  if (insn.isCall) {
    const result = callResultLocation(insn, opts);
    const callSrcs = Array.from({ length: 8 }, (_, i) => ({ t: 'reg', reg: `x${i}`, bits: 64 }));
    if (insn.callTarget == null && ops[0] && ops[0].k === 'reg') {
      const targetReg = regKeyOf(ops[0]);
      if (targetReg && !callSrcs.some((src) => src.reg === targetReg)) callSrcs.push({ t: 'reg', reg: targetReg, bits: 64 });
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
  }
"""
s = replace_once(s, old_call, new_call, "ir call sources")
provenance = """export function stackPointerProvenanceOf(value, memo = new Map(), active = new Set()) {
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

"""
s = replace_once(s, "function buildMemorySSA(ir, df, idom, children) {", provenance + "function buildMemorySSA(ir, df, idom, children) {", "ir provenance helper")
old_escape = """  /*
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
  for (const inst of clobberInsts) {
    for (const [key, loc] of locs) {
      if (loc.kind === MK.STACK && !escapedStack.has('*')) continue;
"""
new_escape = """  const stackPointerMemo = new Map();
  let stackEscaped = false;
  for (const inst of ir.instructions) {
    if (inst.op !== OP.CALL && inst.op !== OP.STORE && inst.op !== OP.UNKNOWN) continue;
    if ((inst.args || []).some((a) => stackPointerProvenanceOf(a?.value, stackPointerMemo))) {
      stackEscaped = true;
      break;
    }
  }

  for (const inst of clobberInsts) {
    for (const [key, loc] of locs) {
      if (loc.kind === MK.STACK && !stackEscaped) continue;
"""
s = replace_once(s, old_escape, new_escape, "ir stack escape")
p.write_text(s)


# Keep all current test commands and inject only the unique aggregate regressions.
p = Path("package.json")
data = json.loads(p.read_text())
def add(script, tokens):
    parts = [x for x in str(data.get("scripts", {}).get(script, "")).split(" && ") if x]
    data["scripts"][script] = " && ".join(tokens + [x for x in parts if x not in tokens])
add("test", ["node tests/issue-193-matching.mjs", "node tests/issue-456-report-completeness.mjs", "node tests/issue-428-schema-provenance.mjs"])
add("semantic:test", ["node tests/issue-425-planner-budget.mjs", "node tests/issues-426-427-semantic-facts.mjs", "node tests/issue-430-memory-escape.mjs"])
add("decompiler:test", ["node tests/issue-429-range-domain.mjs"])
p.write_text(json.dumps(data, indent=2) + "\n")
