import fs from 'node:fs';
const read=(p)=>fs.readFileSync(p,'utf8'); const write=(p,s)=>fs.writeFileSync(p,s);
function rep(p,a,b){const s=read(p);if(!s.includes(a))throw new Error(`anchor missing ${p}: ${a.slice(0,120)}`);write(p,s.replace(a,b));}

// #303-#311 — make expr value/flag/memory semantics conservative and width-correct.
{
  const p='js/expr.js'; let s=read(p);

  s=s.replace(`export function constNode(v) { return node('const', { v: BigInt(v) }); }\nexport function regNode(reg, row) { return node('reg', { reg, row: row == null ? -1 : row }); }`,
`export function constNode(v) { return node('const', { v: BigInt(v) }); }
export function floatNode(v, bits = 64) { return node('fconst', { v: Number(v), bits }); }
export function regNode(reg, row) { return node('reg', { reg, row: row == null ? -1 : row }); }`);

  s=s.replace(`    case 'bin': return [n.a, n.b];\n    case 'un': return [n.a];`,
`    case 'bin': case 'fbin': return [n.a, n.b];
    case 'un': case 'fun': return [n.a];`);

  s=s.replace(`    case 'const': return a.v === b.v;\n    case 'arg':`,
`    case 'const': return a.v === b.v;
    case 'fconst': return Object.is(a.v, b.v) && a.bits === b.bits;
    case 'arg':`);
  s=s.replace(`    case 'un': return a.op === b.op && same(a.a, b.a);\n    case 'bin': return a.op === b.op && same(a.a, b.a) && same(a.b, b.b);`,
`    case 'un': case 'fun': return a.op === b.op && a.bits === b.bits && same(a.a, b.a);
    case 'bin': case 'fbin': return a.op === b.op && a.bits === b.bits && !!a.variableShift === !!b.variableShift && same(a.a, b.a) && same(a.b, b.b);`);
  s=s.replace(`      return a.baseReg === b.baseReg && a.disp === b.disp && a.size === b.size &&\n        (!!a.base === !!b.base)`,
`      return a.baseReg === b.baseReg && a.disp === b.disp && a.size === b.size &&
        a.signed === b.signed && a.resultBits === b.resultBits && a.indexExtend === b.indexExtend && a.indexScale === b.indexScale &&
        (!!a.base === !!b.base)`);

  s=s.replace(`  return node('bin', { op, a, b });\n}`, `  return node('bin', { op, a, b, bits: w });\n}

export function floatBin(op, a, b, bits = 64) {
  if (!a || !b) return null;
  const fa = a.k === 'fconst' ? a.v : null, fb = b.k === 'fconst' ? b.v : null;
  if (fa != null && fb != null) {
    let v;
    if (op === 'fadd') v = fa + fb;
    else if (op === 'fsub') v = fa - fb;
    else if (op === 'fmul') v = fa * fb;
    else if (op === 'fdiv') v = fa / fb;
    else return node('fbin', { op, a, b, bits });
    return floatNode(v, bits);
  }
  return node('fbin', { op, a, b, bits });
}

function floatUn(op, a, bits = 64) {
  if (!a) return null;
  if (a.k === 'fconst' && op === 'fneg') return floatNode(-a.v, bits);
  return node('fun', { op, a, bits });
}

export function variableShift(op, a, b, bits = 64) {
  if (!a || !b) return null;
  const amount = constOf(b);
  if (amount != null) {
    const mask = BigInt(bits === 32 ? 31 : 63);
    return bin(op, a, constNode(amount & mask), bits);
  }
  return node('bin', { op, a, b, bits, variableShift: true });
}`);

  s=s.replace(`  lsl: 'shl', lslv: 'shl', lsr: 'shr', lsrv: 'shr', asr: 'sar', asrv: 'sar',\n  ror: 'ror', rorv: 'ror',\n  fadd: 'add', fsub: 'sub', fmul: 'mul', fdiv: 'sdiv',`,
`  lsl: 'shl', lsr: 'shr', asr: 'sar', ror: 'ror',`);

  s=s.replace(`      if (op.value == null) return op.float != null ? constNode(0n) : null;`, `      if (op.value == null) return op.float != null ? floatNode(op.float, bits) : null;`);

  s=s.replace(`function narrow32(v) {\n  if (!v) return v;\n  if (v.k === 'const') return constNode(wrap(v.v, 32));\n  if (v.k === 'un' && (v.op === 'sxt32' || v.op === 'uxt32')) return v.a;\n  return v;\n}`,
`function narrow32(v) {
  if (!v) return v;
  if (v.k === 'const') return constNode(BigInt.asUintN(32, v.v));
  if (v.k === 'un' && v.op === 'uxt32') return v;
  if (v.k === 'un' && v.op === 'sxt32') return un('uxt32', v.a);
  return un('uxt32', v);
}`);

  s=s.replace(`    const emit = (key, v) => {\n      if (!key || key === 'zr' || !v) return;\n      set(key, v, row);`,
`    const emit = (key, v, writeBits = null) => {
      if (!key || key === 'zr' || !v) return;
      if (writeBits === 32 && /^x\\d+$/.test(key)) v = un('uxt32', v);
      set(key, v, row);`);

  s=s.replace(`          emit(key, v);\n        });`, `          emit(key, v, regBits(dop));\n        });`);
  // arithmetic writes use destination architectural width, including MOVK Wd zero-extension.
  s=s.replaceAll(`emit(dst, txt ? node('str', { addr: txt.addr, text: txt.text }) : valueOf(insn.ops[1], row, bits));`, `emit(dst, txt ? node('str', { addr: txt.addr, text: txt.text }) : valueOf(insn.ops[1], row, bits), bits);`);
  s=s.replace(`        emit(dst, constNode(wrap(cleared | ((imm.value & 0xffffn) << sh), 64)));`, `        emit(dst, constNode(wrap(cleared | ((imm.value & 0xffffn) << sh), bits)), bits);`);

  // Preserve indexed addressing transformation in the memory identity/value itself.
  s=s.replace(`              index: m.index ? regs.get(m.index) || regNode(m.index, row) : null,\n              size: pair ? m.size / 2 : m.size,\n              signed: /^(ldrs|ldurs|ldpsw)/.test(base),`,
`              index: m.index ? applyShift(regs.get(m.index) || regNode(m.index, row), memOp && memOp.shift, 64) : null,
              indexExtend: memOp && memOp.shift && !['lsl','lsr','asr','ror'].includes(memOp.shift.op) ? memOp.shift.op : null,
              indexScale: memOp && memOp.shift ? (memOp.shift.amount || 0) : 0,
              size: pair ? m.size / 2 : m.size,
              resultBits: regBits(dop),
              signed: /^(ldrs|ldurs|ldpsw)/.test(base),`);

  // Post-index address uses the old base; only writeback uses the trailing immediate.
  s=s.replaceAll(`if (memOp && (memOp.mode === 'pre' || memOp.mode === 'post') && m.base && m.disp != null) {\n          emit(m.base, bin('add', get(m.base, row), constNode(m.disp), 64));\n        }`,
`if (memOp && (memOp.mode === 'pre' || memOp.mode === 'post') && m.base) {
          const wb = memOp.writebackDisp && memOp.writebackDisp.value != null ? memOp.writebackDisp.value
            : (memOp.mode === 'pre' && m.disp != null ? m.disp : null);
          if (wb != null) emit(m.base, bin('add', get(m.base, row), constNode(wb), 64), 64);
        }`);

  // Unsupported flag writers must invalidate prior NZCV. CCMP/CCMN are intentionally unknown until modeled conditionally.
  s=s.replace(`    const B = () => valueOf(insn.ops[2], row, bits);\n    /* 末尾に s の付く演算`,
`    const B = () => valueOf(insn.ops[2], row, bits);
    const unsupportedFlagWriter = /^(adcs|sbcs|ngcs|rmif|setf8|setf16|fccmp|fccmpe|ccmp|ccmn)$/.test(base) ||
      (base === 'msr' && /(^|[,\\s])nzcv([,\\s]|$)/i.test(String(insn.operands || '')));
    if (unsupportedFlagWriter) flags = null;
    /* 末尾に s の付く演算`);

  // Floating arithmetic is never represented as integer arithmetic.
  s=s.replace(`    } else if (BIN_MN[base]) {\n      emit(dst, bin(BIN_MN[base], A(), B(), bits));`,
`    } else if (/^(lslv|lsrv|asrv|rorv)$/.test(base)) {
      const op = { lslv: 'shl', lsrv: 'shr', asrv: 'sar', rorv: 'ror' }[base];
      emit(dst, variableShift(op, A(), B(), bits), bits);
    } else if (/^(fadd|fsub|fmul|fdiv)$/.test(base)) {
      emit(dst, floatBin(base, A(), B(), bits), bits);
    } else if (BIN_MN[base]) {
      emit(dst, bin(BIN_MN[base], A(), B(), bits), bits);`);
  s=s.replace(`    } else if (base === 'neg' || base === 'negs' || base === 'fneg') {\n      emit(dst, un('neg', A()));`,
`    } else if (base === 'fneg') {
      emit(dst, floatUn('fneg', A(), bits), bits);
    } else if (base === 'neg' || base === 'negs') {
      emit(dst, un('neg', A()), bits);`);
  s=s.replace(`    } else if (base === 'madd' || base === 'fmadd') {\n      emit(dst, bin('add', valueOf(insn.ops[3], row, bits), bin('mul', A(), B(), bits), bits));\n    } else if (base === 'msub' || base === 'fmsub') {\n      emit(dst, bin('sub', valueOf(insn.ops[3], row, bits), bin('mul', A(), B(), bits), bits));`,
`    } else if (base === 'fmadd') {
      emit(dst, floatBin('fadd', valueOf(insn.ops[3], row, bits), floatBin('fmul', A(), B(), bits), bits), bits);
    } else if (base === 'fmsub') {
      emit(dst, floatBin('fsub', valueOf(insn.ops[3], row, bits), floatBin('fmul', A(), B(), bits), bits), bits);
    } else if (base === 'madd') {
      emit(dst, bin('add', valueOf(insn.ops[3], row, bits), bin('mul', A(), B(), bits), bits), bits);
    } else if (base === 'msub') {
      emit(dst, bin('sub', valueOf(insn.ops[3], row, bits), bin('mul', A(), B(), bits), bits), bits);`);

  // CINC assembler alias semantics: cond true => source+1, false => source.
  s=s.replace(`  if (base === 'cset' || base === 'csetm') {\n    return node('sel', { cc: cond, cmp, a: constNode(base === 'csetm' ? -1n : 1n), b: ZERO });\n  }\n  const a = valueOf(ops[1], row, bits);`,
`  if (base === 'cset' || base === 'csetm') {
    return node('sel', { cc: cond, cmp, a: constNode(base === 'csetm' ? -1n : 1n), b: ZERO });
  }
  const a = valueOf(ops[1], row, bits);
  if (base === 'cinc') return node('sel', { cc: cond, cmp, a: bin('add', a, constNode(1n), bits), b: a });`);
  s=s.replace(`  if (base === 'csinc' || base === 'cinc') alt = bin('add', b, constNode(1n), bits);`, `  if (base === 'csinc') alt = bin('add', b, constNode(1n), bits);`);

  // Do not re-promote CCMP/CCMN to a normal compare after the invalidation above.
  s=s.replace(`    } else if (base === 'cmp' || base === 'cmn' || base === 'tst' || base === 'fcmp' ||\n               base === 'fcmpe' || base === 'ccmp' || base === 'ccmn') {`,
`    } else if (base === 'ccmp' || base === 'ccmn' || base === 'fccmp' || base === 'fccmpe') {
      flags = null;
    } else if (base === 'cmp' || base === 'cmn' || base === 'tst' || base === 'fcmp' || base === 'fcmpe') {`);

  // Rendering for distinct floating nodes.
  s=s.replace(`    case 'const': return hexOf(n.v);\n    case 'arg':`,
`    case 'const': return hexOf(n.v);
    case 'fconst': return Number.isNaN(n.v) ? 'NAN' : n.v === Infinity ? 'INFINITY' : n.v === -Infinity ? '-INFINITY' : Object.is(n.v, -0) ? '-0.0' : String(n.v);
    case 'arg':`);
  s=s.replace(`    case 'un': return emitUn(n, prec, o, depth);\n    case 'sel':`,
`    case 'un': return emitUn(n, prec, o, depth);
    case 'fun': return n.op === 'fneg' ? '-' + emit(n.a, 11, o, depth + 1) : n.op + '(' + emit(n.a, 0, o, depth + 1) + ')';
    case 'fbin': {
      const sym = { fadd: '+', fsub: '-', fmul: '*', fdiv: '/' }[n.op] || n.op;
      const t = emit(n.a, 9, o, depth + 1) + ' ' + sym + ' ' + emit(n.b, 10, o, depth + 1);
      return prec > 9 ? '(' + t + ')' : t;
    }
    case 'sel':`);

  write(p,s);
}

// #317 — separate effective address displacement from writeback displacement.
{
  const p='js/arm64.js'; let s=read(p);
  s=s.replace(`  const mem = { k: 'mem', text, base, index: null, disp: null, shift: null, mode: bang ? 'pre' : 'offset' };`,
`  const mem = { k: 'mem', text, base, index: null, disp: null, addressDisp: null, writebackDisp: null, shift: null, mode: bang ? 'pre' : 'offset' };`);
  s=s.replace(`    if (imm) { mem.disp = imm; continue; }`, `    if (imm) { mem.disp = imm; mem.addressDisp = imm; if (bang) mem.writebackDisp = imm; continue; }`);
  s=s.replace(`      out[i].disp = out[i + 1];\n      out[i].mode = 'post';`, `      out[i].writebackDisp = out[i + 1];
      out[i].addressDisp = null;
      out[i].disp = null;
      out[i].mode = 'post';`);
  write(p,s);
}

// #317 — IR load/store location uses access displacement; base update uses writeback displacement.
{
  const p='js/ir-core.js'; let s=read(p);
  s=s.replace(`      disp: mem && mem.disp && mem.disp.value != null ? mem.disp.value : null,`,
`      disp: mem && (mem.addressDisp || mem.disp) && (mem.addressDisp || mem.disp).value != null ? (mem.addressDisp || mem.disp).value : null,`);
  s=s.replace(`    if (mem && (mem.mode === 'pre' || mem.mode === 'post') && addr.base && addr.disp != null) {\n      push({ op: OP.BIN, sub: 'add', dstReg: addr.base, dstBits: 64,\n        srcs: [{ t: 'reg', reg: addr.base, bits: 64 }, { t: 'imm', value: addr.disp }] });\n    }`,
`    if (mem && (mem.mode === 'pre' || mem.mode === 'post') && addr.base) {
      const wb = mem.writebackDisp && mem.writebackDisp.value != null ? mem.writebackDisp.value
        : (mem.mode === 'pre' ? addr.disp : null);
      if (wb != null) push({ op: OP.BIN, sub: 'add', dstReg: addr.base, dstBits: 64,
        srcs: [{ t: 'reg', reg: addr.base, bits: 64 }, { t: 'imm', value: wb }] });
    }`);
  write(p,s);
}

// #313 — goal confidence counts independent source groups, not raw correlated hits.
{
  const p='js/report.js'; let s=read(p);
  s=s.replace(`import { stackNaming } from './decompile.js';`, `import { stackNaming } from './decompile.js';\nimport { GROUP } from './evidence.js';`);
  s=s.replace(`      if (m) hits.push({ code: 'string-ref', detail: { text: s.text, addr: s.addr, term: m.term } });`, `      if (m) hits.push({ code: 'string-ref', group: GROUP.SEMANTIC, detail: { text: s.text, addr: s.addr, term: m.term } });`);
  s=s.replace(`      if (m) hits.push({ code: 'selector', detail: { selector: sel, term: m.term } });`, `      if (m) hits.push({ code: 'selector', group: GROUP.METADATA, detail: { selector: sel, term: m.term } });`);
  s=s.replace(`      if (m) hits.push({ code: 'name-match', detail: { name: o.name, term: m.term } });`, `      if (m) hits.push({ code: 'name-match', group: GROUP.METADATA, detail: { name: o.name, term: m.term } });`);
  s=s.replace(`      if (m) hits.push({ code: 'caller-name', detail: { name: c.name, term: m.term } });`, `      if (m) hits.push({ code: 'caller-name', group: GROUP.METADATA, detail: { name: c.name, term: m.term } });`);
  s=s.replace(`    if (hits.length) {\n      // 証拠が独立に何本あるかで確度を決める。1 本だけなら断定しない。\n      const conf = Math.min(0.92, 0.35 + 0.18 * hits.length);`,
`    for (const u of updates) {
      const fname = u.field && u.field.certain ? (u.field.name || u.field.label) : null;
      const m = fname ? matchText(goal, fname) : null;
      if (m && u.kind === 'read-modify-write' && (u.confidence || 0) >= 0.8) {
        hits.push({ code: 'verified-dataflow', group: GROUP.DATAFLOW, detail: { field: fname, term: m.term, storeRow: u.store?.row } });
      }
    }
    if (hits.length) {
      const groups = new Set(hits.map((h) => h.group || GROUP.EXTERNAL));
      const groupCount = groups.size;
      // Same-source repeats only improve trace detail, never confidence. Heterogeneous groups do.
      const conf = groupCount <= 1 ? 0.52 : groupCount === 2 ? 0.76 : Math.min(0.91, 0.76 + 0.15 * (groupCount - 2));`);
  write(p,s);
}

// #314 — explicitly propagate guessed-function truncation/completeness.
{
  const p='js/worker.js'; let s=read(p);
  s=s.replace(`  return { starts, cancelled: false, __transfer: [starts.buffer] };\n}`, `  const capped = found.size >= cap;
  return { starts, cancelled: false, capped, complete: !capped, limit: cap,
    range: { start: region.vmAddr, end: region.vmAddr + region.size }, __transfer: [starts.buffer] };
}`);
  write(p,s);
}

// #315/#316 — bound remote plugin downloads before materialization and make persistence transactional.
{
  const p='js/plugins.js'; let s=read(p);
  const old=`  async installFromUrl(url) {
    let text;
    try {
      const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) return { error: '取り寄せられませんでした（' + res.status + '）。' };
      text = await res.text();
    } catch (err) { return { error: '取り寄せに失敗しました: ' + ((err && err.message) || err) }; }
    if (text.length > MAX_SOURCE) return { error: 'プラグインが大きすぎます（512 KB まで）。' };
    return { ok: true, source: text, origin: url, needsConfirmation: true };
  }`;
  const neu=`  async installFromUrl(url) {
    try {
      const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) return { error: '取り寄せられませんでした（' + res.status + '）。' };
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_SOURCE) {
        try { await res.body?.cancel('plugin-too-large'); } catch {}
        return { error: 'プラグインが大きすぎます（512 KB まで）。' };
      }
      let bytes;
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader(); const chunks = []; let total = 0;
        try {
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            total += value.byteLength;
            if (total > MAX_SOURCE) { await reader.cancel('plugin-too-large').catch(() => {}); return { error: 'プラグインが大きすぎます（512 KB まで）。' }; }
            chunks.push(value);
          }
        } finally { try { reader.releaseLock(); } catch {} }
        bytes = new Uint8Array(total); let at = 0; for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
      } else {
        const buf = await res.arrayBuffer();
        if (buf.byteLength > MAX_SOURCE) return { error: 'プラグインが大きすぎます（512 KB まで）。' };
        bytes = new Uint8Array(buf);
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { ok: true, source: text, origin: url, needsConfirmation: true };
    } catch (err) { return { error: '取り寄せに失敗しました: ' + ((err && err.message) || err) }; }
  }`;
  if(!s.includes(old)) throw new Error('installFromUrl replacement anchor missing'); s=s.replace(old,neu);

  // install rollback on save failure.
  s=s.replace(`    this.plugins.push(...added);\n    this.packages.push({ packageId, source, origin: origin || '不明', definitions: added.map((x) => ({ id: x.id, index: x.index })) });\n    if (!opts.silent) this.save();\n    return { ok: true, added };`,
`    const before = { plugins: this.plugins.slice(), packages: this.packages.map((x) => ({ ...x, definitions: x.definitions.slice() })), nextId: this.nextId, nextPackageId: this.nextPackageId };
    this.plugins.push(...added);
    this.packages.push({ packageId, source, origin: origin || '不明', definitions: added.map((x) => ({ id: x.id, index: x.index })) });
    if (!opts.silent && !this.save()) {
      this.plugins = before.plugins; this.packages = before.packages; this.nextId = before.nextId; this.nextPackageId = before.nextPackageId;
      return { error: 'プラグインを保存できませんでした。変更は元に戻しました。' };
    }
    return { ok: true, added };`);
  s=s.replace(`  remove(id) {\n    const target = this.plugins.find((p) => p.id === id);\n    if (!target) return false;\n    this.plugins = this.plugins.filter((p) => p.id !== id);`,
`  remove(id) {
    const target = this.plugins.find((p) => p.id === id);
    if (!target) return false;
    const beforePlugins = this.plugins.slice();
    const beforePackages = this.packages.map((x) => ({ ...x, definitions: x.definitions.slice() }));
    this.plugins = this.plugins.filter((p) => p.id !== id);`);
  s=s.replace(`    this.packages = this.packages.filter((p) => p.definitions.length);\n    this.save();\n    return true;\n  }\n  clear() { this.plugins = []; this.packages = []; this.save(); }`,
`    this.packages = this.packages.filter((p) => p.definitions.length);
    if (!this.save()) { this.plugins = beforePlugins; this.packages = beforePackages; return false; }
    return true;
  }
  clear() {
    const beforePlugins = this.plugins.slice(), beforePackages = this.packages.map((x) => ({ ...x, definitions: x.definitions.slice() }));
    this.plugins = []; this.packages = [];
    if (!this.save()) { this.plugins = beforePlugins; this.packages = beforePackages; return false; }
    return true;
  }`);
  write(p,s);
}

// #318/#319 — count all xrefs exactly and include virtual zero-fill data ranges.
{
  const p='js/linkage.js'; let s=read(p);
  s=s.replace(`    !r.exec && r.size > 0n && /__data|__bss|__common|__const|__cfstring|__objc_(ivar|const|data)/.test(r.section || ''));`,
`    !r.exec && (r.declaredSize != null ? r.declaredSize : r.size) > 0n && /__data|__bss|__common|__const|__cfstring|__objc_(ivar|const|data)/.test(r.section || ''));`);
  s=s.replace(`  const step = n > 400000 ? Math.ceil(n / 400000) : 1;   // 巨大なアプリでは間引く\n  for (let i = 0; i < n; i += step) {`, `  for (let i = 0; i < n; i++) {`);
  s=s.replace(`  const inData = (addr) => dataRegions.find((r) => addr >= r.vmAddr && addr < r.vmAddr + r.declaredSize);`,
`  const inData = (addr) => dataRegions.find((r) => { const size = r.declaredSize != null ? r.declaredSize : r.size; return addr >= r.vmAddr && addr < r.vmAddr + size; });`);
  write(p,s);
}

console.log('issues 303-319 patches applied');
