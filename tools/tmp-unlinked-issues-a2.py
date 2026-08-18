from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one post-batch-A match, got {count}: {old[:160]!r}')
    p.write_text(text.replace(old, new, 1))

# #822 — preserve the flag producer/width and derive condition codes from exact
# NZCV semantics instead of pretending every flag writer was a CMP.
replace_once('js/expr.js',
"    case 'sel': return [n.a, n.b].concat(n.cmp ? [n.cmp.a, n.cmp.b].filter(Boolean) : []);",
"    case 'sel': return [n.a, n.b].concat(n.predicate ? [n.predicate] : [], n.cmp ? [n.cmp.a, n.cmp.b].filter(Boolean) : []);\n    case 'flagcond': return [n.a, n.b].filter(Boolean);")

replace_once('js/expr.js',
"      flags = base === 'negs' ? { op: base, a: ZERO, b: A() } : { op: base, a: A(), b: B() };",
"      flags = base === 'negs' ? { op: base, a: ZERO, b: A(), bits } : { op: base, a: A(), b: B(), bits };")

replace_once('js/expr.js',
'''      flags = {
        op: base,
        a: valueOf(insn.ops[0], row, cbits),
        b: insn.ops[1] ? valueOf(insn.ops[1], row, cbits) : ZERO,
      };''',
'''      flags = {
        op: base,
        a: valueOf(insn.ops[0], row, cbits),
        b: insn.ops[1] ? valueOf(insn.ops[1], row, cbits) : ZERO,
        bits: cbits,
      };''')

# Preserve predicates through legacy expression rewrites.
replace_once('js/expr.js',
"    return (a === n.a && b === n.b) ? n : node('sel', { cc: n.cc, a, b, cmp: n.cmp });",
"    return (a === n.a && b === n.b) ? n : node('sel', { cc: n.cc, a, b, cmp: n.cmp, predicate: n.predicate });")

start = '''function selectNode(insn, row, valueOf, bits, flags) {
  const ops = insn.ops;
  const cc = ops.length ? ops[ops.length - 1] : null;
  const cond = cc && cc.k === 'cond' ? cc.text : null;
  const base = String(insn.mnemonic).toLowerCase();
  /*
   * 何と何を比べた結果なのか。分かっていれば、条件を式として書ける。
   *
   * tst と cmn は「引き算して 0 と比べる」形ではないので、比べる形に直してから渡す。
   *   tst w8, #1  → (w8 & 1) と 0
   *   cmn w8, #4  → (w8 + 4) と 0
   */
  let cmp = null;
  if (flags && flags.a) {
    const zeroOnly = cond === 'eq' || cond === 'ne';
    if ((flags.op === 'tst' || flags.op === 'ands') && zeroOnly) {
      cmp = { a: bin('and', flags.a, flags.b, bits), b: ZERO };
    } else if (flags.op === 'bics' && zeroOnly) {
      cmp = { a: bin('and', flags.a, un('not', flags.b), bits), b: ZERO };
    } else if ((flags.op === 'cmn' || flags.op === 'adds') && zeroOnly) {
      cmp = { a: bin('add', flags.a, flags.b, bits), b: ZERO };
    } else if (flags.op === 'cmp' || flags.op === 'subs' || flags.op === 'negs' || flags.op === 'fcmp' || flags.op === 'fcmpe') {
      cmp = { a: flags.a, b: flags.b };
    }
    if (!cmp?.a || !cmp?.b) cmp = null;
  }
  if (base === 'cset' || base === 'csetm') {
    return node('sel', { cc: cond, cmp, a: constNode(base === 'csetm' ? -1n : 1n), b: ZERO });
  }
  const a = valueOf(ops[1], row, bits);
  const b = ops[2] && ops[2].k !== 'cond' ? valueOf(ops[2], row, bits) : a;
  if (base === 'cinc') {
    const inc = bin('add', a, constNode(1n), bits);
    return node('sel', { cc: cond, cmp, a: inc, b: a });
  }
  let alt = b;
  if (base === 'csinc') alt = bin('add', b, constNode(1n), bits);
  else if (base === 'csinv') alt = un('not', b);
  else if (base === 'csneg') alt = un('neg', b);
  /*
   * どちらを選んでも同じ値なら、選んでいない。
   *
   *   x22 = flag_ne ? flag_ne ? result : flag_lt ? result : 1 : result;
   *
   * こう出ていた行の外側 2 段は、どちらの枝も result だった。
   * 比較が読めなかったときに条件を `flag_ne` と書くので、余計に読めなくなる。
   */
  if (same(a, alt)) return a;
  /*
   * 「大きいほうを採る」「小さいほうを採る」の定型。
   *
   *   cmp x25, #1 ; csel x22, x25, x8, lt      →   x22 = min(result, 1);
   *
   * ARM64 に min / max の命令は無いので、コンパイラは必ず比較と csel の
   * 2 命令で書く。比べた 2 つと選んだ 2 つが同じものなら、それは min か max
   * であって、条件つき代入として読む必要はない。
   */
  const mm = minMaxOf(cond, cmp, a, alt);
  if (mm) return mm;
  return node('sel', { cc: cond, cmp, a, b: alt });
}'''

replacement = r'''function nzcvForConstants(flags) {
  if (!flags || !flags.a || !flags.b) return null;
  const av = constOf(flags.a), bv = constOf(flags.b);
  if (av == null || bv == null) return null;
  const bits = Math.max(1, Math.min(64, Number(flags.bits) || 64));
  const width = BigInt(bits);
  const mask = (1n << width) - 1n;
  const sign = 1n << (width - 1n);
  const a = BigInt.asUintN(bits, av), b = BigInt.asUintN(bits, bv);
  let result = 0n, c = false, v = false;
  if (flags.op === 'adds' || flags.op === 'cmn') {
    const full = a + b;
    result = full & mask;
    c = full > mask;
    v = ((~(a ^ b) & (a ^ result) & sign) !== 0n);
  } else if (flags.op === 'subs' || flags.op === 'cmp' || flags.op === 'negs') {
    result = (a - b) & mask;
    c = a >= b;
    v = (((a ^ b) & (a ^ result) & sign) !== 0n);
  } else if (flags.op === 'ands' || flags.op === 'tst') {
    result = a & b;
    c = false;
    v = false;
  } else if (flags.op === 'bics') {
    result = a & ((~b) & mask);
    c = false;
    v = false;
  } else {
    return null;
  }
  return { n:(result & sign) !== 0n, z:result === 0n, c, v, result, bits };
}

function conditionFromNzcv(nzcv, cond) {
  if (!nzcv || !cond) return null;
  const { n, z, c, v } = nzcv;
  switch (cond) {
    case 'eq': return z;
    case 'ne': return !z;
    case 'cs': case 'hs': return c;
    case 'cc': case 'lo': return !c;
    case 'mi': return n;
    case 'pl': return !n;
    case 'vs': return v;
    case 'vc': return !v;
    case 'hi': return c && !z;
    case 'ls': return !c || z;
    case 'ge': return n === v;
    case 'lt': return n !== v;
    case 'gt': return !z && n === v;
    case 'le': return z || n !== v;
    case 'al': return true;
    case 'nv': return false;
    default: return null;
  }
}

function flagConditionNode(flags, cond) {
  if (!flags || !flags.a || !flags.b || !cond) return null;
  return node('flagcond', {
    cc: cond,
    producer: flags.op,
    bits: Math.max(1, Math.min(64, Number(flags.bits) || 64)),
    a: flags.a,
    b: flags.b,
    semantics: 'aarch64-nzcv-exact',
  });
}

function compareCompatible(flags) {
  if (!flags || !flags.a || !flags.b) return null;
  if (flags.op === 'cmp' || flags.op === 'subs' || flags.op === 'negs') {
    return { a: flags.a, b: flags.b };
  }
  return null;
}

function selectNode(insn, row, valueOf, bits, flags) {
  const ops = insn.ops;
  const cc = ops.length ? ops[ops.length - 1] : null;
  const cond = cc && cc.k === 'cond' ? cc.text : null;
  const base = String(insn.mnemonic).toLowerCase();
  const cmp = compareCompatible(flags);
  const predicate = flagConditionNode(flags, cond);
  const known = conditionFromNzcv(nzcvForConstants(flags), cond);
  if (base === 'cset' || base === 'csetm') {
    const on = constNode(base === 'csetm' ? -1n : 1n);
    if (known != null) return known ? on : ZERO;
    return node('sel', { cc: cond, cmp, predicate, a: on, b: ZERO });
  }
  const a = valueOf(ops[1], row, bits);
  const b = ops[2] && ops[2].k !== 'cond' ? valueOf(ops[2], row, bits) : a;
  if (base === 'cinc') {
    const inc = bin('add', a, constNode(1n), bits);
    if (known != null) return known ? inc : a;
    return node('sel', { cc: cond, cmp, predicate, a: inc, b: a });
  }
  let alt = b;
  if (base === 'csinc') alt = bin('add', b, constNode(1n), bits);
  else if (base === 'csinv') alt = un('not', b);
  else if (base === 'csneg') alt = un('neg', b);
  if (known != null) return known ? a : alt;
  if (same(a, alt)) return a;
  // min/max normalization is restricted to true compare-compatible flag state.
  const mm = minMaxOf(cond, cmp, a, alt);
  if (mm) return mm;
  return node('sel', { cc: cond, cmp, predicate, a, b: alt });
}'''

replace_once('js/expr.js', start, replacement)

# Render non-CMP predicates as explicit producer/width-aware NZCV tests.
replace_once('js/expr.js',
"      const c = n.cc ? condSymbol(n.cc, n.cmp, o, depth) : 'cond';",
"      const c = n.predicate ? emitFlagCondition(n.predicate, o, depth) : (n.cc ? condSymbol(n.cc, n.cmp, o, depth) : 'cond');")

insert_before = '''function condSymbol(cc, cmp, o, depth) {'''
helpers = r'''function emitFlagCondition(predicate, o, depth) {
  if (!predicate || predicate.k !== 'flagcond') return 'flag_unknown';
  const producer = String(predicate.producer || 'unknown');
  const bits = Number(predicate.bits || 64);
  const a = emit(predicate.a, 0, o, depth + 1);
  const b = emit(predicate.b, 0, o, depth + 1);
  const stem = `${producer}${bits}(${a}, ${b})`;
  const atom = (flag) => `${flag}_${stem}`;
  const n = atom('N'), z = atom('Z'), c = atom('C'), v = atom('V');
  switch (predicate.cc) {
    case 'eq': return z;
    case 'ne': return `!${z}`;
    case 'cs': case 'hs': return c;
    case 'cc': case 'lo': return `!${c}`;
    case 'mi': return n;
    case 'pl': return `!${n}`;
    case 'vs': return v;
    case 'vc': return `!${v}`;
    case 'hi': return `${c} && !${z}`;
    case 'ls': return `!${c} || ${z}`;
    case 'ge': return `${n} == ${v}`;
    case 'lt': return `${n} != ${v}`;
    case 'gt': return `!${z} && ${n} == ${v}`;
    case 'le': return `${z} || ${n} != ${v}`;
    case 'al': return 'true';
    case 'nv': return 'false';
    default: return `nzcv_${stem}.${predicate.cc || 'unknown'}`;
  }
}

'''
replace_once('js/expr.js', insert_before, helpers + insert_before)

print('guarded batch A2 exact NZCV patch applied')
