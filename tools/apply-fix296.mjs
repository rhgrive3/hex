import fs from 'node:fs';
const read=(p)=>fs.readFileSync(p,'utf8'); const write=(p,s)=>fs.writeFileSync(p,s);
function rep(p,a,b){const s=read(p);if(!s.includes(a))throw new Error(`anchor missing ${p}: ${a.slice(0,100)}`);write(p,s.replace(a,b));}

// #296/#297 — preserve SSA base identity in origins and never overwrite proven legacy self=true with IR unknown.
{
  const p='js/dataflow-ir.js'; let s=read(p);
  s=s.replace(`import { irFor, readModifyWrite, OP, MK, VK } from './ir.js';`, `import { irFor, readModifyWrite, pointerProvenance, OP, MK, VK } from './ir.js';`);
  s=s.replace(`  if (o.kind === 'field' || o.kind === 'stack') return o.kind + ':' + String(o.base || '') + ':' + String(o.disp ?? '') + ':' + String(o.size ?? '');`,
`  if (o.kind === 'field' || o.kind === 'stack') return o.kind + ':' + String(o.baseRoot || o.baseValueId || o.base || '') + ':' + String(o.disp ?? '') + ':' + String(o.size ?? '');`);
  s=s.replace(`        base: (def.addr && def.addr.baseReg) || null,\n        disp: def.loc.disp,`,
`        base: (def.addr && def.addr.baseReg) || null,
        baseValueId: def.addr && def.addr.base ? def.addr.base.id : null,
        baseRoot: def.addr && def.addr.base ? pointerProvenance(def.addr.base)?.root || null : null,
        disp: def.loc.disp,`);
  s=s.replace(`  const base = (store.addr && store.addr.baseReg) || (load.addr && load.addr.baseReg) || null;\n  const disp = loc.disp != null ? loc.disp : 0n;`,
`  const base = (store.addr && store.addr.baseReg) || (load.addr && load.addr.baseReg) || null;
  const baseValue = (store.addr && store.addr.base) || (load.addr && load.addr.base) || null;
  const provenance = baseValue ? pointerProvenance(baseValue) : null;
  const self = provenance && provenance.must !== false && provenance.kind === 'arg' && provenance.arg === 'x0' ? true : null;
  const disp = loc.disp != null ? loc.disp : 0n;`);
  s=s.replace(`    self: false,\n    irKey: loc.key,`, `    self,\n    baseValueId: baseValue ? baseValue.id : null,\n    baseRoot: provenance ? provenance.root : null,\n    irKey: loc.key,`);
  const mergeAnchor=`function rowIdentity(u) {`;
  if(!s.includes(mergeAnchor)) throw new Error('dataflow rowIdentity anchor');
  s=s.replace(mergeAnchor, `function mergeLocation(oldLoc, irLoc) {
  const merged = { ...(oldLoc || {}), ...(irLoc || {}) };
  if (oldLoc?.self === true && irLoc?.self !== false) merged.self = true;
  else if (irLoc?.self == null && oldLoc && Object.prototype.hasOwnProperty.call(oldLoc, 'self')) merged.self = oldLoc.self;
  return merged;
}

${mergeAnchor}`);
  s=s.replace(`      location: { ...(old.location || {}), ...(ir.location || {}) },`, `      location: mergeLocation(old.location, ir.location),`);
  write(p,s);
}

// #298 — heuristic field names remain inference, never FACT payload.
{
  const p='js/report.js'; let s=read(p);
  s=s.replace(`      field: u.field || null,\n      ops: u.steps.map`, `      field: u.field && u.field.certain ? u.field : null,\n      fieldCandidate: u.field && !u.field.certain ? null : undefined,\n      ops: u.steps.map`);
  s=s.replace(`  for (const u of updates.slice(0, 3)) {\n    if (u.kind !== 'read-modify-write') continue;`,
`  for (const u of updates.slice(0, 3)) {
    if (u.field && !u.field.certain) {
      inferences.push(inference('field-candidate', Math.min(u.confidence || SCORE.inferred, SCORE.inferred), u.evidence || [], { field: u.field, base: u.location.base, disp: u.location.disp }));
    }
    if (u.kind !== 'read-modify-write') continue;`);
  s=s.replace(`      base: u.location.base, disp: u.location.disp, field: u.field || null,`, `      base: u.location.base, disp: u.location.disp, field: u.field && u.field.certain ? u.field : null,`);
  write(p,s);
}

// #299/#300/#301/#302 — CFG-aware accumulator/sink reasoning, operator-aware formula proof, semantic return choice.
{
  const p='js/comprehend.js'; let s=read(p);
  const findAnchor=`export function findAccumulators(model, vg) {`;
  if(!s.includes(findAnchor)) throw new Error('findAccumulators anchor missing');
  const helper=`const CFG_CACHE = new WeakMap();
function controlInfo(model) {
  if (!model || typeof model !== 'object') return null;
  if (CFG_CACHE.has(model)) return CFG_CACHE.get(model);
  const blocks = model.basicBlocks || [];
  const rowToBlock = new Map();
  for (let i = 0; i < blocks.length; i++) for (const row of blocks[i].rows || []) rowToBlock.set(row, i);
  const successors = blocks.map((b) => Array.isArray(b.successors) ? b.successors.slice() : Array.isArray(b.succ) ? b.succ.slice() : null);
  const info = { rowToBlock, successors };
  CFG_CACHE.set(model, info);
  return info;
}
function rowCanReach(model, fromRow, toRow) {
  if (fromRow == null || toRow == null) return false;
  if (fromRow === toRow) return true;
  const info = controlInfo(model);
  const from = info?.rowToBlock.get(fromRow), to = info?.rowToBlock.get(toRow);
  if (from == null || to == null) return false;
  if (from === to) return fromRow <= toRow;
  if (!info.successors[from]) return false; // no CFG proof: abstain rather than chain linear neighbours.
  const seen = new Set([from]), work = [from];
  while (work.length) {
    const b = work.pop();
    for (const next of info.successors[b] || []) {
      if (next === to) return true;
      if (!seen.has(next)) { seen.add(next); work.push(next); }
    }
  }
  return false;
}

`;
  s=s.replace(findAnchor, helper+findAnchor);
  const runAnchor=`      const run = open.get(reg);\n      const last = run && run.steps.length ? run.steps[run.steps.length - 1] : null;`;
  const runRepl=`      let run = open.get(reg);
      if (run && run.steps.length && !rowCanReach(model, run.steps[run.steps.length - 1].row, insn.row)) {
        close(reg);
        run = null;
      }
      const last = run && run.steps.length ? run.steps[run.steps.length - 1] : null;`;
  if(!s.includes(runAnchor)) throw new Error('accumulator run anchor missing');
  s=s.replace(runAnchor,runRepl);

  // Formula claims are keyed by operator+constant. add/sub constants can no longer satisfy ×/÷ claims.
  s=s.replace(`    for (const v of f.mul) if (!claimed.has(v.toString())) claimed.set(v.toString(), { op: '×', v, text: l.text });\n    for (const v of f.div) if (!claimed.has(v.toString())) claimed.set(v.toString(), { op: '÷', v, text: l.text });`,
`    for (const v of f.mul) { const k = 'mul:' + v.toString(); if (!claimed.has(k)) claimed.set(k, { op: '×', v, text: l.text }); }
    for (const v of f.div) { const k = 'div:' + v.toString(); if (!claimed.has(k)) claimed.set(k, { op: '÷', v, text: l.text }); }`);
  s=s.replaceAll(`      const key = use.v.toString();\n      if (!claimed.has(key) || found.has(key)) continue;`, `      const key = use.kind + ':' + use.v.toString();\n      if (!claimed.has(key) || found.has(key)) continue;`);

  // Return selection: computed success values outrank repeated guard/error sentinels.
  s=s.replace(`    groups.push({ value: r.value, n: 1, row: r.row, address: r.address });\n  }\n  groups.sort((a, b) => b.n - a.n || sizeOf(b.value) - sizeOf(a.value));\n  void model;`,
`    const constant = constOf(r.value);
    groups.push({ value: r.value, n: 1, row: r.row, address: r.address, constant });
  }
  for (const g of groups) {
    if (g.constant === undefined) g.constant = constOf(g.value);
    g.guardSentinel = g.constant === 0n || g.constant === -1n || g.constant === 1n;
    g.computed = g.constant == null && sizeOf(g.value) > 1;
  }
  groups.sort((a, b) => Number(b.computed) - Number(a.computed) || Number(a.guardSentinel) - Number(b.guardSentinel) || b.n - a.n || sizeOf(b.value) - sizeOf(a.value));
  void model;`);

  // Sink candidates must be CFG-reachable from the final value definition.
  const sinkLoop=`  for (const insn of insns) {\n    if (insn.row <= last.row) continue;`;
  if(!s.includes(sinkLoop)) throw new Error('findSink loop anchor missing');
  s=s.replace(sinkLoop, `  for (const insn of insns) {\n    if (insn.row <= last.row) continue;\n    if (!rowCanReach(model, last.row, insn.row)) continue;`);
  write(p,s);
}

console.log('issues 296-302 semantic patches applied');
