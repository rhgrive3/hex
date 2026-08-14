from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
def read(p): return (ROOT / p).read_text()
def write(p, s): (ROOT / p).write_text(s)
def once(s, old, new, name):
    n = s.count(old)
    if n != 1: raise RuntimeError(f'{name}: expected 1, got {n}')
    return s.replace(old, new, 1)

s = read('js/decompile.js')
s = once(s,
"  const body = [];\n  const state = { labels: new Set(), gotos: 0, depth: 0, openLoops: new Set(), emitted: new Set(), recovered: 0 };\n  emitRange(cfg, 0, cfg.nodes.length - 1, 1, body, ctx, state, null);\n  const coverage = recoverUnemittedBlocks(cfg, body, ctx, state);",
"  const body = [];\n  let state = newEmitState();\n  emitRange(cfg, 0, cfg.nodes.length - 1, 1, body, ctx, state, null);\n\n  /*\n   * A structured rendering is only trustworthy if it consumed the complete\n   * function.  Mixing a pretty prefix with hundreds of recovered blocks at\n   * the end is technically complete but visually lies about address order.\n   * If even one Basic Block was left behind, restart in faithful linear-CFG\n   * mode: physical addresses stay monotonic and every control edge is explicit.\n   */\n  const structuredMissing = cfg.nodes.length - state.emitted.size;\n  let coverage;\n  if (structuredMissing > 0) {\n    body.length = 0;\n    state = newEmitState();\n    if (ctx.usedVars && ctx.usedVars.clear) ctx.usedVars.clear();\n    emitLinearCfg(cfg, body, ctx, state);\n    coverage = recoverUnemittedBlocks(cfg, body, ctx, state);\n    coverage.mode = 'linear';\n    coverage.structuredMissing = structuredMissing;\n  } else {\n    coverage = recoverUnemittedBlocks(cfg, body, ctx, state);\n    coverage.mode = 'structured';\n    coverage.structuredMissing = 0;\n  }",
'top fallback')

# Insert state constructor before emitRange.
needle = "/**\n * [from, to] の節点を順に訳す。"
insert = "function newEmitState() {\n  return { labels: new Set(), gotos: 0, depth: 0, openLoops: new Set(), emitted: new Set(), recovered: 0 };\n}\n\n"
s = once(s, needle, insert + needle, 'state constructor')

# Add explicit linear CFG renderer before recovery helper.
needle = "/** Final correctness net: every reachable Basic Block must appear at least once. */\nfunction recoverUnemittedBlocks"
linear = r'''/**
 * Exact fallback for optimized/irreducible/disconnected layouts.
 * Blocks are emitted once in physical address order.  Internal control-flow is
 * represented with explicit gotos, so this mode never has to guess a source
 * language structure and never moves a hidden cleanup block somewhere else.
 */
function emitLinearCfg(cfg, out, ctx, state) {
  for (let i = 0; i < cfg.nodes.length; i++) {
    const n = cfg.nodes[i];
    emitBlockBody(n, 1, out, ctx, state, { skipTerminator: true });

    if (n.cond && n.condTarget != null) {
      // If both outcomes are literally the next block, the branch has no
      // observable control-flow effect and can be omitted from pseudocode.
      if (n.condTarget === n.fall) continue;
      const t = labelOf(cfg.nodes[n.condTarget], ctx);
      state.labels.add(t);
      out.push(line('ctrl', 1, 'if (' + condText(n.cond, ctx) + ') goto ' + t + ';',
        n.endRow, addrOf(ctx, n.endRow)));
      state.gotos++;
      if (n.fall != null && n.fall !== i + 1) {
        const f = labelOf(cfg.nodes[n.fall], ctx);
        state.labels.add(f);
        out.push(line('ctrl', 1, 'goto ' + f + ';', n.endRow));
        state.gotos++;
      }
      continue;
    }

    if (n.jump != null && n.jump !== i + 1) {
      const t = labelOf(cfg.nodes[n.jump], ctx);
      state.labels.add(t);
      out.push(line('ctrl', 1, 'goto ' + t + ';', n.endRow, addrOf(ctx, n.endRow)));
      state.gotos++;
    }
    // Unknown-target `br`/conditional branches are deliberately left in the
    // block as __asm by emitBlockBody; pretending to know their target is worse.
  }
}

/** Final correctness net: every Basic Block in the function must appear at least once. */
function recoverUnemittedBlocks'''
s = once(s, needle, linear, 'linear renderer')

# Add user-facing faithful-mode warning.
s = once(s,
"  if (coverage.recovered) {\n    warnings.push('構造化できなかった共有・間接経路 ' + coverage.recovered + ' ブロックを goto で安全に補完しました（関数内の処理は省略していません）。');\n  }",
"  if (coverage.mode === 'linear') {\n    warnings.push('制御フローが高度に最適化されているため、アドレス順の正確モードで表示しています（関数内の処理は省略していません）。');\n  }\n  if (coverage.recovered) {\n    warnings.push('構造化できなかった共有・間接経路 ' + coverage.recovered + ' ブロックを goto で安全に補完しました（関数内の処理は省略していません）。');\n  }",
'linear warning')
write('js/decompile.js', s)

# Regression checks: complex BattleCats output must no longer visually jump
# around; faithful mode is monotonic by address.
s = read('tests/battlecats-cfg-regression.mjs')
anchor = "assert(result.coverage.emitted === result.coverage.total,\n  `not every function block was emitted: ${JSON.stringify(result.coverage)}`);"
extra = anchor + "\nassert(result.coverage.mode === 'linear',\n  `complex optimized function did not select faithful linear mode: ${JSON.stringify(result.coverage)}`);\nconst addresses = result.lines.filter((l) => l.addr != null).map((l) => BigInt(l.addr));\nfor (let i = 1; i < addresses.length; i++) {\n  assert(addresses[i] >= addresses[i - 1],\n    `decompiler address order jumped backwards at ${addresses[i - 1].toString(16)} -> ${addresses[i].toString(16)}`);\n}"
s = once(s, anchor, extra, 'battle monotonic')
write('tests/battlecats-cfg-regression.mjs', s)

s = read('tests/cfg-structuring.mjs')
anchor = "assert(indirect.result.coverage.emitted === indirect.result.coverage.total,\n  'coverage does not include every Basic Block');"
extra = anchor + "\nassert(indirect.result.coverage.mode === 'linear', 'disconnected CFG did not use faithful mode');"
s = once(s, anchor, extra, 'indirect mode')
write('tests/cfg-structuring.mjs', s)

print('linear CFG fallback applied')
