from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, found {count}')
    p.write_text(text.replace(old, new, 1))


replace_once('js/schema.js',
"""function plainAccess(w) {
  const m = W.memoryAccess(w);
  if (!m || m.indexed || m.pair || m.disp == null) return null;
  return { load: m.load, size: m.size, base: m.base, disp: Number(m.disp), reg: m.reg };
}
""",
"""function plainAccess(w) {
  const m = W.memoryAccess(w);
  if (!m || m.indexed || m.pair || m.disp == null) return null;
  return { load: m.load, size: m.size, base: m.base, disp: Number(m.disp), reg: m.reg };
}

/* Lightweight GPR lifetime tracking for the raw-word schema pass. This is not a
 * replacement for Semantic SSA; it is a fail-closed generation marker so the
 * same architectural register number cannot join stores across an observed
 * redefinition. */
function writtenGpr(w) {
  const pcRel = W.pcRelTarget(w, 0n);
  if (pcRel) return pcRel.reg;
  const mw = moveWide(w);
  if (mw) return mw.d;
  const kind = W.classifyWord(w);
  if ([W.KIND.MOVREG, W.KIND.ARITH, W.KIND.MUL, W.KIND.DIV, W.KIND.LOGIC, W.KIND.SHIFT, W.KIND.CSEL].includes(kind)) return rd(w);
  if ((kind === W.KIND.LOAD || kind === W.KIND.LITERAL) && ((w >>> 26) & 1) === 0) return rd(w);
  return null;
}
""")

replace_once('js/schema.js',
"""  const flow = controlContext(words, base);

  let lastCall = -1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
""",
"""  const flow = controlContext(words, base);
  const baseGeneration = new Uint32Array(32);

  let lastCall = -1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const written = writtenGpr(w);
    if (written != null && written >= 0 && written < 31) baseGeneration[written]++;
""")

replace_once('js/schema.js',
"""    if (W.isCallImm(w) || W.isIndirectCall(w)) {
      lastCall = i;
      // 呼び出しで壊れるレジスタの定数は捨てる（x0-x18）
      for (let r = 0; r <= 18; r++) known[r] = 0;
      continue;
    }
""",
"""    if (W.isCallImm(w) || W.isIndirectCall(w)) {
      lastCall = i;
      // 呼び出しで壊れるレジスタの定数とlifetimeは捨てる（x0-x18）。
      for (let r = 0; r <= 18; r++) { known[r] = 0; baseGeneration[r]++; }
      continue;
    }
""")

replace_once('js/schema.js',
"""    if (pa && !pa.load && pa.reg === 0 && lastCall >= 0 && i - lastCall <= 3 && pa.base !== 31) {
      fixed.push({ row: i, addr: base + BigInt(i * 4), base: pa.base, disp: pa.disp, size: pa.size });
      continue;
    }
""",
"""    if (pa && !pa.load && pa.reg === 0 && lastCall >= 0 && i - lastCall <= 3 && pa.base !== 31) {
      fixed.push({
        row: i, addr: base + BigInt(i * 4), base: pa.base, disp: pa.disp, size: pa.size,
        block: flow.blockOf[i], loop: flow.loopOf[i], baseGeneration: baseGeneration[pa.base],
        fromCall: true, callRow: lastCall, callAddr: base + BigInt(lastCall * 4),
      });
      continue;
    }
""")

replace_once('js/schema.js',
"""/**
 * 拾った断片から、表としてつじつまの合うものを組み立てる。
 *
 * 1 つの関数が何本ものファイルを読むことがある（unitlevel / unitbuy / unitexp が
 * 同じ関数の中にある）。表も 1 つとは限らないので、見つかったぶんだけ全部返す。
 * つじつまが合わないものも隠さないが、合ったものを先に置く。
 */
function buildSchema({ loops, fixed, scales, cmps, bumped, base }) {
""",
"""function fixedRegion(f) {
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

/** Build only provenance-coherent unrolled tables. Exported for deterministic regression tests. */
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
        kind: 'unrolled',
        columns: offsets.length,
        columnStride: stride,
        columnSize: sorted[0].size,
        recordStride: null,
        records: null,
        consistent: true,
        fromCall: true,
        storeAddr: sorted[0].addr,
        offsets,
        scaled: [],
        provenance: {
          base: sorted[0].base,
          baseGeneration: sorted[0].baseGeneration,
          region,
          callRows: sorted.map((f) => f.callRow),
          callAddrs: sorted.map((f) => f.callAddr ?? null),
          storeRows: sorted.map((f) => f.row),
        },
        offsetOf(i) { return i >= 0 && i < offsets.length ? offsets[i] : null; },
      });
    }
  }
  return tables;
}

/**
 * 拾った断片から、表としてつじつまの合うものを組み立てる。
 *
 * 1 つの関数が何本ものファイルを読むことがある（unitlevel / unitbuy / unitexp が
 * 同じ関数の中にある）。表も 1 つとは限らないので、見つかったぶんだけ全部返す。
 * つじつまが合わないものも隠さないが、合ったものを先に置く。
 */
function buildSchema({ loops, fixed, scales, cmps, bumped, base }) {
""")

replace_once('js/schema.js',
"""  /* 展開されている形 — 呼び出しの直後の固定ずらしが、そのまま列の並びになる */
  const byBase = new Map();
  for (const f of fixed) {
    if (!byBase.has(f.base)) byBase.set(f.base, []);
    byBase.get(f.base).push(f);
  }
  for (const list of byBase.values()) {
    if (list.length < 3) continue;
    const sorted = list.slice().sort((a, b) => a.row - b.row);
    const offsets = sorted.map((f) => f.disp);
    tables.push({
      kind: 'unrolled',
      columns: offsets.length,
      columnStride: null,
      columnSize: sorted[0].size,
      recordStride: null,
      records: null,
      consistent: null,
      storeAddr: sorted[0].addr,
      offsets,
      scaled: [],
      offsetOf(i) { return i >= 0 && i < offsets.length ? offsets[i] : null; },
    });
  }
""",
"""  /* 展開形はCFG region + base lifetime + call-return provenanceを共有するrunだけ。 */
  tables.push(...unrolledTablesFromFixed(fixed));
""")

replace_once('package.json',
"""\"test\": \"node tests/issues-97-100-146-147.mjs""",
"""\"test\": \"node tests/issue-428-schema-provenance.mjs && node tests/issues-97-100-146-147.mjs""")
