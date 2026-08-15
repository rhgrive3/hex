from pathlib import Path

P = Path(__file__).resolve().parents[1] / 'js/comprehend.js'
s = P.read_text()

def rep(old, new, count=1):
    global s
    if old not in s:
        raise RuntimeError('missing comprehend pattern: ' + old[:120])
    s = s.replace(old, new, count)

# #300 — formula identity is operation + constant, not the constant alone.
rep("""  const claimed = new Map();          // 数 → その数を書いている文言
  for (const l of labels) {
    const f = formulaOf(l.text);
    if (!f) continue;
    for (const v of f.mul) if (!claimed.has(v.toString())) claimed.set(v.toString(), { op: '×', v, text: l.text });
    for (const v of f.div) if (!claimed.has(v.toString())) claimed.set(v.toString(), { op: '÷', v, text: l.text });
  }""",
"""  const claimed = new Map();          // 演算 + 数 → その計算を書いている文言
  const formulaKey = (kind, value) => `${kind}:${value.toString()}`;
  for (const l of labels) {
    const f = formulaOf(l.text);
    if (!f) continue;
    for (const v of f.mul) {
      const key = formulaKey('mul', v);
      if (!claimed.has(key)) claimed.set(key, { op: '×', kind: 'mul', v, text: l.text });
    }
    for (const v of f.div) {
      const key = formulaKey('div', v);
      if (!claimed.has(key)) claimed.set(key, { op: '÷', kind: 'div', v, text: l.text });
    }
  }""")
rep("""      const key = use.v.toString();
      if (!claimed.has(key) || found.has(key)) continue;
      found.set(key, { use, step: st });""",
"""      if (use.kind !== 'mul' && use.kind !== 'div') continue;
      const key = formulaKey(use.kind, use.v);
      if (!claimed.has(key) || found.has(key)) continue;
      found.set(key, { use, step: st });""", 1)
rep("""          const key = use.v.toString();
          if (!claimed.has(key) || found.has(key)) continue;
          found.set(key, { use, step: { row, address: addressOfRow(vg, row) } });""",
"""          if (use.kind !== 'mul' && use.kind !== 'div') continue;
          const key = formulaKey(use.kind, use.v);
          if (!claimed.has(key) || found.has(key)) continue;
          found.set(key, { use, step: { row, address: addressOfRow(vg, row) } });""", 1)
rep("""  const distinct = new Set(hits.map((h) => h.value.toString())).size;""",
"""  const distinct = new Set(hits.map((h) => `${h.used}:${h.value.toString()}`)).size;""")

# #302 — follow the value along CFG paths, not by global row order.
start = s.index('export function findSink(model, vg, acc) {')
end = s.index('\n/* ────────────────────────────────────────────────────────────\n   5. 出口', start)
new_sink = r'''export function findSink(model, vg, acc) {
  if (!acc || !acc.steps.length) return null;
  const last = acc.steps[acc.steps.length - 1];
  const insns = model.instructions || [];
  const byRow = new Map(insns.map((i) => [i.row, i]));
  const rows = insns.map((i) => i.row).sort((a, b) => a - b);
  const nextRow = new Map();
  for (let i = 0; i + 1 < rows.length; i++) nextRow.set(rows[i], rows[i + 1]);
  const rowAtAddress = new Map();
  for (const i of insns) if (i.address != null) rowAtAddress.set(i.address.toString(), i.row);

  const callByRow = new Map();
  for (const c of model.calls || []) callByRow.set(c.row, c);
  const writesByRow = new Map();
  for (const w of vg.memWrites || []) {
    if (!writesByRow.has(w.row)) writesByRow.set(w.row, []);
    writesByRow.get(w.row).push(w);
  }

  const successors = (insn) => {
    if (!insn || insn.isReturn) return [];
    const fallthrough = nextRow.get(insn.row);
    if (insn.isBranch && !insn.isCall) {
      const target = insn.branchTarget == null ? null : rowAtAddress.get(insn.branchTarget.toString());
      if (insn.isConditional) return [target, fallthrough].filter((x, i, a) => x != null && a.indexOf(x) === i);
      return target == null ? [] : [target];
    }
    return fallthrough == null ? [] : [fallthrough];
  };

  const lastInsn = byRow.get(last.row);
  const initialRows = lastInsn ? successors(lastInsn) : rows.filter((r) => r > last.row).slice(0, 1);
  const queue = initialRows.map((row) => ({ row, cur: last.after, clamps: [] }));
  const seen = new Set();
  const sinks = [];
  const clampOnly = [];
  let budget = 0;

  while (queue.length && budget++ < 8192) {
    const state = queue.shift();
    const insn = byRow.get(state.row);
    if (!insn) continue;
    const identity = `${state.row}:${render(state.cur, { maxLen: 640 })}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    let cur = state.cur;
    let clamps = state.clamps;

    for (const w of writesByRow.get(insn.row) || []) {
      if (contains(w.value, cur)) sinks.push({ kind: 'store', row: insn.row, address: insn.address, write: w, clamps });
    }
    const call = callByRow.get(insn.row);
    if (call) {
      for (let a = 0; a <= 7; a++) {
        const v = vg.at(insn.row, 'x' + a);
        if (!v || !contains(v, cur)) continue;
        sinks.push({
          kind: 'argument', row: insn.row, address: insn.address,
          name: call.name || null, target: call.target != null ? call.target : null,
          index: a, clamps,
        });
      }
    }
    if (insn.isReturn) {
      const v = vg.at(insn.row, 'x0');
      if (v && contains(v, cur)) sinks.push({ kind: 'return', row: insn.row, address: insn.address, clamps });
    }
    if (sinks.length) continue;

    const defs = vg.defs.get(insn.row);
    if (defs) {
      for (const reg of Object.keys(defs)) {
        const v = defs[reg];
        if (!v || !contains(v, cur)) continue;
        if (v.k === 'sel') clamps = clamps.concat([{ row: insn.row, address: insn.address, cc: v.cc, expr: v }]);
        cur = v;
        break;
      }
    }
    const next = successors(insn);
    if (!next.length && clamps.length) clampOnly.push({ kind: 'clamped', clamps, certain: true });
    for (const row of next) queue.push({ row, cur, clamps });
  }

  if (sinks.length) {
    const keyOf = (x) => [x.kind, x.row, x.index ?? '', x.write?.baseReg ?? '', x.write?.disp ?? '', x.target ?? ''].join(':');
    const unique = new Map(sinks.map((x) => [keyOf(x), x]));
    // Divergent branches reaching different consumers are not one certain sink.
    if (unique.size === 1) return unique.values().next().value;
    return { kind: 'ambiguous', certain: false, candidates: [...unique.values()].slice(0, 8) };
  }
  if (clampOnly.length === 1) return clampOnly[0];

  // Weak proximity fallback remains explicitly uncertain and is restricted to
  // CFG-reachable rows rather than a sibling branch with a larger row number.
  const reachable = new Set();
  const q = initialRows.slice();
  while (q.length && reachable.size < 4096) {
    const row = q.shift();
    if (reachable.has(row)) continue;
    reachable.add(row);
    for (const n of successors(byRow.get(row))) q.push(n);
  }
  for (const row of [...reachable].sort((a, b) => a - b)) {
    const insn = byRow.get(row);
    if (!insn || row - last.row > 96) continue;
    if (!/^(csel|csinc|csinv|csneg|smax|smin|umax|umin)$/.test(String(insn.mnemonic).toLowerCase())) continue;
    if (!insn.reads.includes(acc.reg)) continue;
    return { kind: 'clamped', certain: false, clamps: [{ row, address: insn.address, cc: null, expr: null }] };
  }
  return null;
}
'''
s = s[:start] + new_sink + s[end:]

# #301 — repeated guard/error constants must not outvote a computed success result.
old = """function returnValue(model, vg) {
  const list = (vg.returns || []).filter((r) => r.value);
  if (!list.length) return null;
  // 同じ値を返す出口が多いなら、それがこの関数の答え
  const groups = [];
  for (const r of list) {
    const hit = groups.find((g) => same(g.value, r.value));
    if (hit) { hit.n++; continue; }
    groups.push({ value: r.value, n: 1, row: r.row, address: r.address });
  }
  groups.sort((a, b) => b.n - a.n || sizeOf(b.value) - sizeOf(a.value));
  void model;
  return groups[0];
}"""
new = """function returnValue(model, vg) {
  const list = (vg.returns || []).filter((r) => r.value);
  if (!list.length) return null;
  const groups = [];
  for (const r of list) {
    const hit = groups.find((g) => same(g.value, r.value));
    if (hit) { hit.n++; continue; }
    groups.push({ value: r.value, n: 1, row: r.row, address: r.address });
  }
  const semanticRank = (v) => {
    if (!v) return -1;
    if (v.k === 'call') return 6;
    if (v.k === 'sel' || v.k === 'bin') return 5;
    if (v.k === 'un' || v.k === 'mem') return 4;
    if (v.k === 'str' || v.k === 'addr') return 3;
    if (v.k === 'arg' || v.k === 'reg') return 2;
    if (v.k === 'const') return v.v === 0n ? 0 : 1;
    return 1;
  };
  // Exit frequency is not semantic importance: error/guard exits often return
  // 0 many times while the success path returns one computed value once.
  groups.sort((a, b) => semanticRank(b.value) - semanticRank(a.value) ||
    sizeOf(b.value) - sizeOf(a.value) || b.n - a.n || a.row - b.row);
  void model;
  return groups[0];
}"""
if old not in s:
    raise RuntimeError('returnValue pattern missing')
s = s.replace(old, new, 1)

P.write_text(s)
print('comprehend fixes applied')
