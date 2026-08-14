import fs from 'node:fs';
const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, s) => fs.writeFileSync(p, s);
function rep(p, a, b) {
  const s = read(p);
  if (!s.includes(a)) throw new Error(`anchor missing ${p}: ${a.slice(0,120)}`);
  write(p, s.replace(a, b));
}

// #265: cache identity includes the analyzed end boundary.
rep('js/analyze.js',
`function cacheKey(region, startRow, symbols) {
  return (symbols && symbols.gen != null ? symbols.gen : 0) + ':' + region.id + '#' + startRow;
}`,
`function cacheKey(region, startRow, endRow, symbols) {
  return (symbols && symbols.gen != null ? symbols.gen : 0) + ':' + region.id + '#' + startRow + ':' + endRow;
}`);
rep('js/analyze.js', `  const key = cacheKey(region, startRow, symbols);`, `  const key = cacheKey(region, startRow, endRow, symbols);`);

// #266: invalidate ADRP provenance on writes (including pair loads) and calls.
rep('js/analyze.js',
`      if (di >= 0 && ops[di] && ops[di].k === 'reg' && ops[di].cls === 'gp') {
        written.add(ops[di].num);
        if (ops[di].num === 0) { lastX0Write = row; }
      }`,
`      if (di >= 0 && ops[di] && ops[di].k === 'reg' && ops[di].cls === 'gp') {
        written.add(ops[di].num);
        pageOf.delete(ops[di].num);
        if (ops[di].num === 0) { lastX0Write = row; }
      }
      if (/^(ldp|ldnp)$/.test(b) && ops[1] && ops[1].k === 'reg' && ops[1].cls === 'gp') {
        written.add(ops[1].num);
        pageOf.delete(ops[1].num);
      }`);
rep('js/analyze.js',
`      if (isCall(b)) {
        if (b === 'bl') {`,
`      if (isCall(b)) {
        // AAPCS64: calls clobber x0-x18, so an ADRP page held there cannot survive the call.
        for (let r = 0; r <= 18; r++) pageOf.delete(r);
        if (b === 'bl') {`);

// #267: a dispatched bytes-only chunk is upgraded with a second request before onChunk fires.
rep('js/backend.js',
`    const inflight = this.inflight.get(key);
    if (inflight) { if (wantAsm && !inflight.wantAsm) inflight.wantAsm = true; return; }`,
`    const inflight = this.inflight.get(key);
    if (inflight) {
      if (wantAsm && !inflight.wantAsm) inflight.wantAsm = true;
      return;
    }`);
rep('js/backend.js',
`  _dispatch(job) {
    this.call('chunk', { regionId: job.regionId, chunk: job.chunk, wantAsm: job.wantAsm })
      .then((res) => {
        this.inflight.delete(job.key);
        if (job.gen !== this.gen) return;
        this.cache.set(job.key, normalizeChunk(res));
        this.onChunk?.(job.regionId, job.chunk);
      })
      .catch((err) => {
        this.inflight.delete(job.key);
        if (job.gen !== this.gen || err?.stale) return;
        this.cache.set(job.key, { bytes: new Uint8Array(0), rows: 0, mn: null, ops: null, error: err.message });
        this.onChunk?.(job.regionId, job.chunk, err);
      })
      .then(() => {
        const next = this.queue.shift();
        if (next) this._dispatch(next);
      });
  }`,
`  _dispatch(job) {
    job.dispatched = true;
    this.call('chunk', { regionId: job.regionId, chunk: job.chunk, wantAsm: job.wantAsm })
      .then(async (res) => {
        if (job.gen !== this.gen) return null;
        let entry = normalizeChunk(res);
        // request(false) may have been upgraded while the first worker request was already in flight.
        if (job.wantAsm && !entry.mn) {
          const upgraded = await this.call('chunk', { regionId: job.regionId, chunk: job.chunk, wantAsm: true });
          if (job.gen !== this.gen) return null;
          entry = normalizeChunk(upgraded);
          if (!entry.mn) throw new Error('Chunk assembly upgrade did not return disassembly.');
        }
        this.inflight.delete(job.key);
        this.cache.set(job.key, entry);
        this.onChunk?.(job.regionId, job.chunk);
        return entry;
      })
      .catch((err) => {
        this.inflight.delete(job.key);
        if (job.gen !== this.gen || err?.stale) return;
        this.cache.set(job.key, { bytes: new Uint8Array(0), rows: 0, mn: null, ops: null, error: err.message });
        this.onChunk?.(job.regionId, job.chunk, err);
      })
      .then(() => {
        const next = this.queue.shift();
        if (next) this._dispatch(next);
      });
  }`);

// #268/#269/#270: typed diagnostics, retryable memo failures, complete notable scan, referenced-only findings.
rep('js/auto.js', `  const list = symbols.functionList(region, 20000);\n  const out = [];\n  for (const f of list) {`,
`  const out = [];
  const funcs = symbols.funcs || [];
  const lo = region ? region.vmAddr : null;
  const hi = region ? region.vmAddr + region.size : null;
  for (let i = 0; i < funcs.length; i++) {
    const addr = funcs[i];
    if (lo != null && addr < lo) continue;
    if (hi != null && addr >= hi) break;
    const f = { addr, name: symbols.nameAt(addr) || null };`);
rep('js/auto.js',
`    out.push({ addr: f.addr, name: f.name, score, reasons, stats, called, range });
  }
  out.sort((a, b) => b.score - a.score || (a.addr < b.addr ? -1 : 1));
  return out.slice(0, limit);`,
`    out.push({ addr: f.addr, name: f.name, score, reasons, stats, called, range });
    // Keep memory bounded while still scoring every function.
    if (out.length > Math.max(512, limit * 64)) {
      out.sort((a, b) => b.score - a.score || (a.addr < b.addr ? -1 : 1));
      out.length = Math.max(256, limit * 32);
    }
  }
  out.sort((a, b) => b.score - a.score || (a.addr < b.addr ? -1 : 1));
  return out.slice(0, limit);`);
rep('js/auto.js',
`      const users = program
        ? program.functionsReferencing(s.addr, BigInt(Math.min(s.text.length, 256)), 8)
        : [];
      out.push({`,
`      const users = program
        ? program.functionsReferencing(s.addr, BigInt(Math.min(s.text.length, 256)), 8)
        : [];
      if (!users.length) continue;
      out.push({`);
rep('js/auto.js', `    notes: [],\n  };`, `    notes: [],\n    diagnostics: [],\n  };`);
rep('js/auto.js', `  const memo = o.analyze ? memoize(o.analyze) : null;`,
`  const recordDiagnostic = (phase, error) => {
    const d = autoDiagnostic(phase, error);
    report.diagnostics.push(d);
    if (!report.notes.includes(d.type)) report.notes.push(d.type);
  };
  const memo = o.analyze ? memoize(o.analyze, (error) => recordDiagnostic('analyze', error)) : null;`);
rep('js/auto.js',
`  const runWithBudget = async (max, fn) => {
    if (budget.left <= 0 || max <= 0) return null;
    const purse = { left: Math.max(0, Math.min(max, perGoal, budget.left)) };
    const before = purse.left;
    let result = null;
    try { result = await fn(purse); } catch { result = null; }
    budget.left -= (before - purse.left);
    return result;
  };`,
`  const runWithBudget = async (max, fn, phase = 'pinpoint') => {
    if (budget.left <= 0 || max <= 0) return null;
    const purse = { left: Math.max(0, Math.min(max, perGoal, budget.left)) };
    const before = purse.left;
    let result = null;
    try { result = await fn(purse); }
    catch (error) { recordDiagnostic(phase, error); result = null; }
    budget.left -= (before - purse.left);
    return result;
  };`);
rep('js/auto.js',
`function memoize(analyze) {
  const cache = new Map();
  return (addr, end) => {
    const key = addr == null ? 'null' : addr.toString();
    if (cache.has(key)) return cache.get(key);
    const p = Promise.resolve()
      .then(() => analyze(addr, end))
      .catch(() => null);
    cache.set(key, p);
    if (cache.size > 400) cache.delete(cache.keys().next().value);
    return p;
  };
}`,
`export function memoizeAnalysis(analyze, onError = null) {
  const cache = new Map();
  return (addr, end) => {
    const key = (addr == null ? 'null' : addr.toString()) + ':' + (end == null ? 'null' : end.toString());
    if (cache.has(key)) return cache.get(key);
    const p = Promise.resolve().then(() => analyze(addr, end));
    cache.set(key, p);
    p.catch((error) => {
      if (cache.get(key) === p) cache.delete(key); // failed analysis is retryable, never memoized as “no result”.
      if (onError) onError(error);
    });
    if (cache.size > 400) cache.delete(cache.keys().next().value);
    return p;
  };
}

function memoize(analyze, onError) { return memoizeAnalysis(analyze, onError); }

function autoDiagnostic(phase, error) {
  const code = String(error?.type || error?.code || error?.name || 'error').toLowerCase();
  let type = 'fatal-failure';
  if (code.includes('unsupported') || code.includes('not_supported')) type = 'unsupported';
  else if (error?.stale || code.includes('timeout') || code.includes('network') || code.includes('abort') || code.includes('temporary') || error?.transient) type = 'transient-failure';
  return { phase, type, code, message: String(error?.message || error || 'analysis failed').slice(0, 500) };
}`);

// #271: without a proven function end, never attribute all later calls to the seed.
rep('js/rank.js',
`      const range = program.functionRange(seed.addr);
      const end = range ? range.end : null;

      for (const callee of program.calleesOf(seed.addr, end, 40)) {`,
`      const range = program.functionRange(seed.addr);
      if (!range || range.end == null) continue;
      const end = range.end;

      for (const callee of program.calleesOf(seed.addr, end, 40)) {`);

// #272/#273: IMP ownership is 1:N and superclass lookup is cycle-safe.
rep('js/fields.js', `    this.methodOwner = new Map();  // 実装アドレス(string) -> {className, sel, kind}`, `    this.methodOwner = new Map();  // 実装アドレス(string) -> Array<{className, sel, kind}>`);
rep('js/fields.js',
`        this.methodOwner.set(m.addr.toString(), {
          className: c.name, sel: m.sel || null, kind: m.kind || '-',
          accessorField: accessorField(m.sel),
        });`,
`        const owner = {
          className: c.name, sel: m.sel || null, kind: m.kind || '-',
          accessorField: accessorField(m.sel),
        };
        const mk = m.addr.toString();
        const owners = this.methodOwner.get(mk) || [];
        if (!owners.some((x) => x.className === owner.className && x.sel === owner.sel && x.kind === owner.kind)) owners.push(owner);
        this.methodOwner.set(mk, owners);`);
rep('js/fields.js',
`  ownerOf(funcAddr) {
    if (funcAddr == null) return null;
    return this.methodOwner.get(funcAddr.toString()) || null;
  }`,
`  ownerOf(funcAddr) {
    const owners = this.ownersOf(funcAddr);
    if (!owners.length) return null;
    if (owners.length === 1) return owners[0];
    return { ambiguous: true, owners, className: null, sel: null, kind: null, accessorField: null };
  }

  ownersOf(funcAddr) {
    if (funcAddr == null) return [];
    return (this.methodOwner.get(funcAddr.toString()) || []).slice();
  }`);
rep('js/fields.js', `  fieldAt(className, offset) {\n    const c = this.classes.get(className);`,
`  fieldAt(className, offset, seen = new Set()) {
    if (seen.has(className)) return null;
    seen.add(className);
    const c = this.classes.get(className);`);
rep('js/fields.js', `      const up = this.fieldAt(c.superName, offset);`, `      const up = this.fieldAt(c.superName, offset, seen);`);

// #274: verification keeps the narrowed hypothesis universe used for the initial prior.
rep('js/pinpoint.js',
`  const narrowed = asked.length > 0 && asked.length < candidates.length;
  if (asked.length) candidates = asked;

  // 事前オッズは「値の総数」から。2 万個あるなら 1/20000 から始める。
  for (const c of candidates) c.fusion = fuse(c.evidence, { candidates: narrowed ? asked.length : universe });`,
`  const narrowed = asked.length > 0 && asked.length < candidates.length;
  if (asked.length) candidates = asked;
  const priorCandidates = narrowed ? asked.length : universe;

  // Keep the same hypothesis universe before and after verification.
  for (const c of candidates) c.fusion = fuse(c.evidence, { candidates: priorCandidates });`);
rep('js/pinpoint.js', `      for (const c of ranked) c.fusion = fuse(c.evidence, { candidates: universe });`, `      for (const c of ranked) c.fusion = fuse(c.evidence, { candidates: priorCandidates });`);

// #275/#276: self is row-specific; compare evidence must stay in the load's basic block.
rep('js/verify.js',
`function touches(insn, selfSet, offset) {
  const m = insn.memory;
  if (!m || m.indexed || m.disp == null || m.stack) return false;
  if (!selfSet.has(m.base)) return false;
  return m.disp === offset;
}`,
`function touches(insn, isSelf, offset) {
  const m = insn.memory;
  if (!m || m.indexed || m.disp == null || m.stack) return false;
  if (!isSelf(m.base, insn.row)) return false;
  return m.disp === offset;
}`);
rep('js/verify.js', `  const { set, isSelf } = selfRegisters(model);\n  void set;`, `  const { isSelf } = selfRegisters(model);`);
rep('js/verify.js', `    const store = insns.find((i) => touches(i, set, offset) && i.memory.kind === 'store');`, `    const store = insns.find((i) => touches(i, isSelf, offset) && i.memory.kind === 'store');`);
rep('js/verify.js',
`  const byRow = new Map(insns.map((i) => [i.row, i]));
  const comparisonByRow = new Map(constantComparisons(model, { allowUnscopedPropagated: true })`,
`  const byRow = new Map(insns.map((i) => [i.row, i]));
  const blockOfRow = new Map();
  for (const block of model.basicBlocks || []) {
    for (const row of block.rows || []) blockOfRow.set(row, block.index);
  }
  const comparisonByRow = new Map(constantComparisons(model, { allowUnscopedPropagated: true })`);
rep('js/verify.js',
`      const next = byRow.get(r);
      if (!next) continue;
      const mn = String(next.mnemonic || '').toLowerCase();`,
`      const next = byRow.get(r);
      if (!next) continue;
      if (blockOfRow.size && blockOfRow.get(next.row) !== blockOfRow.get(site.row)) continue;
      const mn = String(next.mnemonic || '').toLowerCase();`);

// #277/#278: note edits are transactional and imports are binary-bound.
{
  const p = 'js/names.js';
  let s = read(p);
  const inject = `\n  _commitMap(map, k, value) {\n    const had = map.has(k);\n    const previous = map.get(k);\n    const dirty = this.dirty;\n    if (value == null || value === '') map.delete(k); else map.set(k, value);\n    this.dirty = true;\n    if (this.save()) return true;\n    if (had) map.set(k, previous); else map.delete(k);\n    this.dirty = dirty;\n    return false;\n  }\n`;
  const anchor = `  /* ── 名前 ─────────────────────────────────────────────── */`;
  if (!s.includes(anchor)) throw new Error('names commit anchor');
  s = s.replace(anchor, inject + '\n' + anchor);
  s = s.replace(`    if (!k) return;\n    const clean = cleanName(name);\n    if (clean) this.names.set(k, clean);\n    else this.names.delete(k);\n    this.dirty = true;\n    this.save();`, `    if (!k) return false;\n    const clean = cleanName(name);\n    return this._commitMap(this.names, k, clean);`);
  s = s.replace(`    if (!k) return;\n    const clean = (text || '').toString().slice(0, 500).trim();\n    if (clean) this.comments.set(k, clean);\n    else this.comments.delete(k);\n    this.dirty = true;\n    this.save();`, `    if (!k) return false;\n    const clean = (text || '').toString().slice(0, 500).trim();\n    return this._commitMap(this.comments, k, clean);`);
  s = s.replace(`    if (clean) this.vars.set(kk, clean);\n    else this.vars.delete(kk);\n    this.dirty = true;\n    this.save();`, `    return this._commitMap(this.vars, kk, clean);`);
  s = s.replace(`    if (clean) this.types.set(kk, clean);\n    else this.types.delete(kk);\n    this.dirty = true;\n    this.save();`, `    return this._commitMap(this.types, kk, clean);`);
  s = s.replace(`  fromJSON(text) {\n    const o = JSON.parse(text);\n    let n = 0;`, `  fromJSON(text) {\n    const o = JSON.parse(text);\n    if (o.id && this.id && String(o.id) !== String(this.id)) throw new Error('notes-binary-mismatch');\n    const before = { names: new Map(this.names), comments: new Map(this.comments), vars: new Map(this.vars), types: new Map(this.types), structs: this.structs.slice(), dirty: this.dirty };\n    let n = 0;`);
  s = s.replace(`    if (Array.isArray(o.structs)) this.structs = this.structs.concat(o.structs);\n    this.save();\n    return n;`, `    if (Array.isArray(o.structs)) this.structs = this.structs.concat(o.structs);\n    this.dirty = true;\n    if (!this.save()) {\n      this.names = before.names; this.comments = before.comments; this.vars = before.vars; this.types = before.types; this.structs = before.structs; this.dirty = before.dirty;\n      throw new Error('notes-save-failed');\n    }\n    return n;`);
  write(p, s);
}

// #279: a call result is only a call result while the x0 definition remains live.
rep('js/schema.js', `const rm = (w) => (w >>> 16) & 31;`,
`const rm = (w) => (w >>> 16) & 31;

function writesRegister(w, reg) {
  if (W.isCallImm(w) || W.isIndirectCall(w) || W.isBranchImm(w) || W.isCondBranch(w) || W.isRet(w) || W.isBr(w)) return false;
  const mem = W.memoryAccess(w);
  if (mem) return !!mem.load && mem.reg === reg;
  if (W.compareImmediate(w) != null) return false;
  return rd(w) === reg;
}`);
rep('js/schema.js', `  let lastCall = -1;\n  for (let i = 0; i < words.length; i++) {\n    const w = words[i];`,
`  let lastCall = -1;
  let x0Version = 0;
  let lastCallX0Version = -1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const isCall = W.isCallImm(w) || W.isIndirectCall(w);
    if (!isCall && writesRegister(w, 0)) x0Version++;`);
rep('js/schema.js',
`    if (W.isCallImm(w) || W.isIndirectCall(w)) {
      lastCall = i;`,
`    if (isCall) {
      lastCall = i;
      x0Version++;
      lastCallX0Version = x0Version;`);
rep('js/schema.js', `          fromCall: lastCall >= 0 && i - lastCall <= 3 && ix.reg === 0,`, `          fromCall: lastCall >= 0 && i - lastCall <= 3 && ix.reg === 0 && lastCallX0Version === x0Version,`);
rep('js/schema.js', `    if (pa && !pa.load && pa.reg === 0 && lastCall >= 0 && i - lastCall <= 3 && pa.base !== 31) {`, `    if (pa && !pa.load && pa.reg === 0 && lastCall >= 0 && i - lastCall <= 3 && lastCallX0Version === x0Version && pa.base !== 31) {`);

// #280/#281: carry object identity + scan completeness through shape folding.
{
  const p = 'js/worker.js';
  let s = read(p);
  s = s.replace(`  const evAmtKind = new Uint8Array(MAX_SHAPE_EVENTS);\n  const evSpan = new Int32Array(MAX_SHAPE_EVENTS);`, `  const evAmtKind = new Uint8Array(MAX_SHAPE_EVENTS);\n  const evSpan = new Int32Array(MAX_SHAPE_EVENTS);\n  const evObjectId = new Uint32Array(MAX_SHAPE_EVENTS);\n  const evAmtObjectId = new Uint32Array(MAX_SHAPE_EVENTS);`);
  s = s.replace(`  const pAmtKind = new Uint8Array(32);`, `  const pAmtKind = new Uint8Array(32);\n  const pAmtObjectId = new Uint32Array(32);\n  const objectId = new Uint32Array(32);\n  let nextObjectId = 1;\n  for (let r = 0; r < 32; r++) objectId[r] = nextObjectId++;`);
  s = s.replace(`  const forget = (r) => {\n    if (r < 0 || r >= 31) return;\n    pBase[r] = -1;\n    // 別のものを入れたのだから、それまでの「入れ物の大きさ」も引き継がない\n    spanOf[r] = 0;\n  };\n  const forgetAll = () => { pBase.fill(-1); };`, `  const forget = (r) => {\n    if (r < 0 || r >= 31) return;\n    pBase[r] = -1;\n    spanOf[r] = 0;\n    objectId[r] = nextObjectId++;\n  };\n  const forgetAll = () => { for (let r = 0; r < 31; r++) forget(r); };`);
  s = s.replace(`    if (d !== s) spanOf[d] = spanOf[s];\n    pBase[d] = pBase[s];`, `    if (d !== s) spanOf[d] = spanOf[s];\n    objectId[d] = objectId[s];\n    pBase[d] = pBase[s];`);
  s = s.replace(`    pAmtKind[d] = pAmtKind[s]; pAmtBase[d] = pAmtBase[s];\n    pAmtDisp[d] = pAmtDisp[s];`, `    pAmtKind[d] = pAmtKind[s]; pAmtBase[d] = pAmtBase[s]; pAmtObjectId[d] = pAmtObjectId[s];\n    pAmtDisp[d] = pAmtDisp[s];`);
  s = s.replace(`    pAmtKind[d] = kind; pAmtBase[d] = base == null ? -1 : base;\n    pAmtDisp[d] = disp || 0;`, `    pAmtKind[d] = kind; pAmtBase[d] = base == null ? -1 : base;\n    pAmtObjectId[d] = base != null && base >= 0 ? objectId[base] : 0;\n    pAmtDisp[d] = disp || 0;`);
  s = s.replace(`            spanOf[r] = 0;                     // 読み込んだ先は「別のもの」になる\n            pBase[r] = mem.base;`, `            spanOf[r] = 0;                     // 読み込んだ先は「別のもの」になる\n            objectId[r] = nextObjectId++;\n            pBase[r] = mem.base;`);
  s = s.replace(`            pAmtKind[r] = AMT_NONE; pAmtBase[r] = -1; pAmtDisp[r] = 0; pAmtScaled[r] = 0;`, `            pAmtKind[r] = AMT_NONE; pAmtBase[r] = -1; pAmtObjectId[r] = 0; pAmtDisp[r] = 0; pAmtScaled[r] = 0;`);
  s = s.replace(`          evSpan[n] = spanOf[mem.base];\n          evAmtSize[n] = pAmtSize[s];`, `          evSpan[n] = spanOf[mem.base];\n          evObjectId[n] = objectId[mem.base];\n          evAmtObjectId[n] = pAmtObjectId[s];\n          evAmtSize[n] = pAmtSize[s];`);
  s = s.replace(`  const span = evSpan.slice(0, n);\n  const amtSize = evAmtSize.slice(0, n), amtSpan = evAmtSpan.slice(0, n);`, `  const span = evSpan.slice(0, n);\n  const objectId = evObjectId.slice(0, n), amtObjectId = evAmtObjectId.slice(0, n);\n  const amtSize = evAmtSize.slice(0, n), amtSpan = evAmtSpan.slice(0, n);`);
  s = s.replace(`    addr, disp, size, flags, amtKind, amtDisp, span, amtSize, amtSpan,\n    __transfer: [addr.buffer, disp.buffer, size.buffer, flags.buffer,`, `    addr, disp, size, flags, amtKind, amtDisp, span, objectId, amtObjectId, amtSize, amtSpan,\n    __transfer: [addr.buffer, disp.buffer, size.buffer, flags.buffer,`);
  s = s.replace(`amtKind.buffer, amtDisp.buffer, span.buffer, amtSize.buffer, amtSpan.buffer]`, `amtKind.buffer, amtDisp.buffer, span.buffer, objectId.buffer, amtObjectId.buffer, amtSize.buffer, amtSpan.buffer]`);
  write(p, s);
}
{
  const p = 'js/shapes.js';
  let s = read(p);
  s = s.replace(`  const span = scan.span || null;`, `  const span = scan.span || null;\n  const objectIds = scan.objectId || null;\n  const amountObjectIds = scan.amtObjectId || null;\n  const complete = !scan.capped && !scan.cancelled;\n  const keyOf = (id, offset) => id ? String(id) + ':' + String(offset) : offset;\n  out.complete = complete; out.capped = !!scan.capped; out.cancelled = !!scan.cancelled;`);
  s = s.replace(`    const d = disp[i];\n    let e = out.get(d);`, `    const d = disp[i];\n    const identityKey = keyOf(objectIds ? objectIds[i] : 0, d);\n    let e = out.get(identityKey);`);
  s = s.replace(`        offset: d, size: size[i],`, `        offset: d, objectId: objectIds ? objectIds[i] : 0, identityKey, complete, size: size[i],`);
  s = s.replace(`      out.set(d, e);`, `      out.set(identityKey, e);`);
  s = s.replace(`      const a = amtDisp[i];\n      e.amountFrom.set(a, (e.amountFrom.get(a) || 0) + 1);`, `      const a = amtDisp[i];\n      const sourceKey = keyOf(amountObjectIds ? amountObjectIds[i] : 0, a);\n      e.amountFrom.set(sourceKey, (e.amountFrom.get(sourceKey) || 0) + 1);`);
  s = s.replace(`    const a = amtDisp[i];\n    let src = out.get(a);`, `    const a = amtDisp[i];\n    const sourceKey = keyOf(amountObjectIds ? amountObjectIds[i] : 0, a);\n    const targetKey = keyOf(objectIds ? objectIds[i] : 0, disp[i]);\n    let src = out.get(sourceKey);`);
  s = s.replace(`        offset: a, size: 0,`, `        offset: a, objectId: amountObjectIds ? amountObjectIds[i] : 0, identityKey: sourceKey, complete, size: 0,`);
  s = s.replace(`      out.set(a, src);`, `      out.set(sourceKey, src);`);
  s = s.replace(`    src.usedAgainst.set(disp[i], (src.usedAgainst.get(disp[i]) || 0) + 1);`, `    src.usedAgainst.set(targetKey, (src.usedAgainst.get(targetKey) || 0) + 1);`);
  s = s.replace(`const ROLE_MARGIN = 1.25;`, `const ROLE_MARGIN = 1.25;\nconst shapeKey = (e) => e && e.identityKey != null ? e.identityKey : e.offset;`);
  s = s.replace(`for (const e of folded.values()) if (resourceScore(e) > 0) draft.add(e.offset);`, `for (const e of folded.values()) if (resourceScore(e) > 0) draft.add(shapeKey(e));`);
  s = s.replace(`    roles.set(e.offset, { role, resource: res, damage: dmg });`, `    roles.set(shapeKey(e), { role, resource: res, damage: dmg });`);
  s = s.replaceAll(`roles.get(e.offset)`, `roles.get(shapeKey(e))`);
  s = s.replace(`function resourceScore(e) {`, `function resourceScore(e) {`);
  s = s.replace(`  return Math.min(1, s);\n}\n\n/* ── 役は`, `  s = Math.min(1, s);\n  return e.complete === false ? s * 0.35 : s;\n}\n\n/* ── 役は`);
  // damage score has its own final return; damp incomplete scans there too.
  const dmgReturn = `  return Math.min(1, s);\n}\n\n/**\n * 攻撃力`;
  if (s.includes(dmgReturn)) s = s.replace(dmgReturn, `  s = Math.min(1, s);\n  return e.complete === false ? s * 0.35 : s;\n}\n\n/**\n * 攻撃力`);
  s = s.replace(`  const e = folded.get(offset);\n  if (!e) return null;`, `  let e = folded.get(offset);\n  if (!e) {\n    const matches = Array.from(folded.values()).filter((row) => row.offset === Number(offset));\n    if (matches.length !== 1) return null; // same displacement on multiple object identities is ambiguous.\n    e = matches[0];\n  }`);
  write(p, s);
}

// #282: every query result carries source-index completeness so absence is never over-interpreted.
{
  const p = 'js/program.js';
  let s = read(p);
  const helper = `\nfunction markQueryCompleteness(array, complete, kind) {\n  array.complete = !!complete;\n  array.capped = !complete;\n  array.source = kind;\n  return array;\n}\n`;
  s = s.replace(`function lowerBoundDirect(values, addr) {`, helper + `\nfunction lowerBoundDirect(values, addr) {`);
  s = s.replace(`  get statsComplete() { return this.kindsCovered >= this.words; }`, `  get statsComplete() { return this.kindsCovered >= this.words; }\n  get queryCompleteness() { return { calls: !this.callsCapped, refs: !this.refsCapped, stats: this.statsComplete }; }`);
  s = s.replace(`    return out;\n  }\n\n  /** 呼び出し元の関数の一覧`, `    return markQueryCompleteness(out, !this.callsCapped, 'calls');\n  }\n\n  /** 呼び出し元の関数の一覧`);
  s = s.replace(`    return Array.from(seen.values());\n  }\n\n  /** この関数が呼んでいる先`, `    return markQueryCompleteness(Array.from(seen.values()), !this.callsCapped, 'calls');\n  }\n\n  /** この関数が呼んでいる先`);
  s = s.replace(`    return Array.from(out.values());\n  }\n\n  /** 何回呼ばれているか`, `    return markQueryCompleteness(Array.from(out.values()), !this.callsCapped, 'calls');\n  }\n\n  /** 何回呼ばれているか`);
  s = s.replace(`    return out;\n  }\n\n  /** そのアドレスを参照している関数`, `    return markQueryCompleteness(out, !this.refsCapped, 'refs');\n  }\n\n  /** そのアドレスを参照している関数`);
  s = s.replace(`    return Array.from(seen.values());\n  }\n\n  /** その関数が指しているアドレス`, `    return markQueryCompleteness(Array.from(seen.values()), !this.refsCapped, 'refs');\n  }\n\n  /** その関数が指しているアドレス`);
  s = s.replace(`    return out;\n  }\n\n  /* ── 関数ごとの命令`, `    return markQueryCompleteness(out, !this.refsCapped, 'refs');\n  }\n\n  /* ── 関数ごとの命令`);
  write(p, s);
}

console.log('issues 265-282 patches applied');
