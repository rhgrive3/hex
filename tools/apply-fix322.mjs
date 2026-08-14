import fs from 'node:fs';
const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, s) => fs.writeFileSync(p, s);
function rep(p, a, b) {
  const s = read(p);
  if (!s.includes(a)) throw new Error(`anchor missing ${p}: ${a.slice(0,120)}`);
  write(p, s.replace(a, b));
}

// #322 — trace history owns a bounded deep snapshot; callers cannot mutate stored history afterwards.
{
  const p = 'js/trace/ring-buffer.js';
  let s = read(p);
  s = s.replace(`function estimateBytes(event) {
  try { return JSON.stringify(event, (_,v) => typeof v === 'bigint' ? v.toString() : v).length * 2; }
  catch { return 256; }
}`, `function estimateBytes(event) {
  try { return JSON.stringify(event, (_,v) => typeof v === 'bigint' ? v.toString() : ArrayBuffer.isView(v) ? Array.from(v) : v).length * 2; }
  catch { return 256; }
}

function snapshotValue(value, budget, seen = new WeakMap(), depth = 0) {
  if (budget.left <= 0) return '[truncated]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'bigint') { budget.left -= 16; return value; }
  if (typeof value === 'string') { const max = Math.max(0, Math.min(value.length, Math.floor(budget.left / 2))); budget.left -= max * 2; return max < value.length ? value.slice(0, max) + '…' : value; }
  if (typeof value !== 'object') { const text = String(value); budget.left -= text.length * 2; return text; }
  if (seen.has(value)) return '[circular]';
  if (depth >= 24) return '[depth-limit]';
  if (value instanceof ArrayBuffer) {
    const n = Math.min(value.byteLength, budget.left); budget.left -= n;
    return value.slice(0, n);
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = Math.min(value.byteLength, budget.left); budget.left -= bytes;
    const raw = new Uint8Array(value.buffer, value.byteOffset, bytes).slice();
    if (value instanceof DataView) return new DataView(raw.buffer);
    const Ctor = value.constructor;
    const unit = Ctor.BYTES_PER_ELEMENT || 1;
    return new Ctor(raw.buffer, 0, Math.floor(raw.byteLength / unit));
  }
  const out = Array.isArray(value) ? [] : {};
  seen.set(value, out);
  const keys = Array.isArray(value) ? Array.from({ length: value.length }, (_, i) => String(i)) : Object.keys(value);
  for (const key of keys) {
    if (budget.left <= 0) break;
    budget.left -= String(key).length * 2 + 8;
    out[key] = snapshotValue(value[key], budget, seen, depth + 1);
  }
  return out;
}

function eventSnapshot(event, maxBytes) {
  const value = event && typeof event === 'object' ? event : { type:'event', value:event };
  return snapshotValue(value, { left: Math.max(256, maxBytes) });
}`);
  s = s.replace(`    const safe = event && typeof event === 'object' ? { ...event } : { type:'event', value:event };
    const size = estimateBytes(safe);`, `    const safe = eventSnapshot(event, Math.min(this.maxBytes, 1024 * 1024));
    const size = estimateBytes(safe);`);
  s = s.replace(`    return { events:this.events.slice(this.events.length - n).map(({__bytes,__aggregateKey,...e}) => e), seen:this.seen, dropped:this.dropped, bytes:this.bytes, aggregates:Object.fromEntries(this.aggregates) };`, `    return { events:this.events.slice(this.events.length - n).map(({__bytes,__aggregateKey,...e}) => eventSnapshot(e, Math.min(this.maxBytes, 1024 * 1024))), seen:this.seen, dropped:this.dropped, bytes:this.bytes, aggregates:Object.fromEntries(this.aggregates) };`);
  write(p, s);
}

// #323 — encode the ObjC property helper ABI explicitly. setter: x2=offset, x3=value.
{
  const p = 'js/dataflow-semantic.js';
  let s = read(p);
  const before = `function propertyHelperUpdates(model, ir) {
  const out = [];
  const callMeta = new Map((model.calls || []).map((c) => [c.row, c]));`;
  const after = `const OBJC_PROPERTY_HELPERS = Object.freeze([
  { re: /^_?objc_getProperty(?:_non_gc)?$/, kind: 'read', offsetReg: 'x2', valueReg: 'x0' },
  { re: /^_?objc_setProperty(?:_non_gc)?$/, kind: 'write', offsetReg: 'x2', valueReg: 'x3' },
  { re: /^_?objc_setProperty_atomic(?:_copy)?$/, kind: 'write', offsetReg: 'x2', valueReg: 'x3' },
  { re: /^_?objc_setProperty_nonatomic(?:_copy)?$/, kind: 'write', offsetReg: 'x2', valueReg: 'x3' },
]);

function propertyHelperUpdates(model, ir) {
  const out = [];
  const callMeta = new Map((model.calls || []).map((c) => [c.row, c]));`;
  if (!s.includes(before)) throw new Error('property helper start missing');
  s = s.replace(before, after);
  s = s.replace(`    if (!name || !/objc_(getProperty|setProperty)/.test(name)) continue;
    const read = /objc_getProperty/.test(name);
    const offsetReg = read ? 'x2' : 'x3';
    const offsetValue = valueBefore(ir, inst, offsetReg);`, `    const abi = name ? OBJC_PROPERTY_HELPERS.find((h) => h.re.test(name)) : null;
    if (!abi) continue;
    const read = abi.kind === 'read';
    const offsetValue = valueBefore(ir, inst, abi.offsetReg);`);
  s = s.replace(`      store: { row: inst.row, address: inst.address, reg: read ? 'x0' : 'x2' },
      register: read ? 'x0' : 'x2',`, `      store: { row: inst.row, address: inst.address, reg: abi.valueReg },
      stored: read ? null : { type: 'reg', reg: abi.valueReg, value: valueBefore(ir, inst, abi.valueReg) },
      register: abi.valueReg,`);
  write(p, s);
}

// #324 — an explicit receiver type is a hard dispatch boundary, never a hint that falls back globally.
{
  const p = 'js/apple/objc-runtime.js';
  let s = read(p);
  const old = `  if (receiverType) {
    const narrowed = candidates.filter((m) => ranks.has(m.className) || (m.source === 'protocol' && allowedProtocols.has(m.className)));
    if (narrowed.length) candidates = narrowed;
  }
  candidates.sort((a, b) => b.score - a.score || String(a.className).localeCompare(String(b.className)));`;
  const neu = `  if (receiverType) {
    const receiverName = cleanClassName(receiverType);
    const knownReceiver = !!(receiverName && index.classes.has(receiverName));
    const narrowed = candidates.filter((m) => ranks.has(m.className) || (m.source === 'protocol' && allowedProtocols.has(m.className)));
    if (!knownReceiver || !narrowed.length) {
      return { resolved: null, candidates: [], confidence: 0, receiverType: receiverName, selector, classMethod: !!classMethod,
        reason: knownReceiver ? 'selector has no target on receiver hierarchy or protocols' : 'receiver type is not present in parsed metadata' };
    }
    candidates = narrowed;
  }
  candidates.sort((a, b) => b.score - a.score || String(a.className).localeCompare(String(b.className)));`;
  if (!s.includes(old)) throw new Error('objc narrowing anchor missing');
  write(p, s.replace(old, neu));
}

// #325 — preserve concrete BL/BLR target at execution time rather than reparsing only instruction text.
{
  const p = 'js/emu.js';
  let s = read(p);
  s = s.replace(`    this.breakpoints = new Set();`, `    this.breakpoints = new Set();
    this.lastCall = null;`);
  s = s.replace(`    if (this.trace.length < 4000) this.trace.push({ addr: at, text });
    this.steps++;`, `    const traceEvent = { addr: at, text };
    if (this.trace.length < 4000) this.trace.push(traceEvent);
    this.lastCall = null;
    this.steps++;`);
  s = s.replace(`      const jumped = await this.execute(insn.mn.toLowerCase(), insn.ops || '', at);
      if (jumped != null) next = jumped;`, `      const jumped = await this.execute(insn.mn.toLowerCase(), insn.ops || '', at);
      if (this.lastCall) Object.assign(traceEvent, this.lastCall);
      if (jumped != null) next = jumped;`);
  s = s.replace(`    return { ok: !this.stopped, text, reason: this.stopped };`, `    return { ok: !this.stopped, text, reason: this.stopped, call: this.lastCall ? { ...this.lastCall } : null };`);
  s = s.replace(`      if (target == null) throw new Error('呼び出し先が分かりませんでした。');
      const hooked = await this.hookedCall(target);`, `      if (target == null) throw new Error('呼び出し先が分かりませんでした。');
      this.lastCall = { callTarget: target, callIndirect: mn === 'blr' };
      const hooked = await this.hookedCall(target);`);
  write(p, s);
}
{
  const p = 'js/adapters/index.js';
  let s = read(p);
  s = s.replace(`function callsFromTrace(trace) {
  return (trace || []).filter((e) => /^(bl|blr)\\b/i.test(e.text || '')).map((e) => {
    const match = /^bl\\s+#?(0x[0-9a-f]+|[0-9]+)/i.exec(e.text || '');
    let target = null; try { if (match) target = BigInt(match[1]); } catch { target = null; }
    return { type:'call', address:e.addr ?? e.address, target, text:e.text };
  });
}`, `export function callsFromTrace(trace) {
  return (trace || []).filter((e) => e.callTarget != null || /^(bl|blr)\\b/i.test(e.text || '')).map((e) => {
    let target = e.callTarget ?? null;
    if (target == null) {
      const match = /^bl\\s+#?(0x[0-9a-f]+|[0-9]+)/i.exec(e.text || '');
      try { if (match) target = BigInt(match[1]); } catch { target = null; }
    }
    return { type:'call', address:e.addr ?? e.address, target, indirect:e.callIndirect === true || /^blr\\b/i.test(e.text || ''), text:e.text };
  });
}`);
  s = s.replace(`    const after = cloneRegisters(sandbox.emulator); const event = { type:'instruction', address:before.pc, addr:before.pc, text:raw.text, ok:raw.ok, reason:raw.reason };`, `    const after = cloneRegisters(sandbox.emulator); const event = { type:'instruction', address:before.pc, addr:before.pc, text:raw.text, ok:raw.ok, reason:raw.reason,
      ...(raw.call || {}) };`);
  write(p, s);
}

// #326/#327 — enforce the project byte cap both before Blob materialization and after serialization.
{
  const p = 'js/project/index.js';
  let s = read(p);
  s = s.replace(`const MAX_PROJECT_BYTES = 16 * 1024 * 1024;`, `export const MAX_PROJECT_BYTES = 16 * 1024 * 1024;`);
  s = s.replace(`export function serializeHexProject(project) {
  const normalized = validateHexProject(project);
  return JSON.stringify(normalized, (_key, value) => typeof value === 'bigint' ? { [BIGINT_TAG]: value.toString() } : value, 2);
}`, `export function serializeHexProject(project) {
  const normalized = validateHexProject(project);
  const text = JSON.stringify(normalized, (_key, value) => typeof value === 'bigint' ? { [BIGINT_TAG]: value.toString() } : value, 2);
  if (byteLength(text) > MAX_PROJECT_BYTES) throw new ProjectFormatError('project exceeds 16 MiB serialized limit', 'HEX_PROJECT_TOO_LARGE');
  return text;
}`);
  s = s.replace(`export async function importHexProject(input) {
  if (typeof Blob !== 'undefined' && input instanceof Blob) return parseHexProject(await input.text());`, `export async function importHexProject(input) {
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    if (input.size > MAX_PROJECT_BYTES) throw new ProjectFormatError('project exceeds 16 MiB serialized limit', 'HEX_PROJECT_TOO_LARGE');
    return parseHexProject(await input.text());
  }`);
  write(p, s);
}

// #328 — score all feature hits; keep strongest K independent of discovery order.
{
  const p = 'js/features.js';
  let s = read(p);
  const old = `    const list = buckets.get(hit.feature);
    if (!list || list.length >= perFeature) continue;
    list.push({ ...hit, score: strength(hit, opts) });`;
  const neu = `    const list = buckets.get(hit.feature);
    if (!list) continue;
    const scored = { ...hit, score: strength(hit, opts) };
    let at = list.findIndex((row) => scored.score > row.score);
    if (at < 0) at = list.length;
    list.splice(at, 0, scored);
    if (list.length > perFeature) list.length = perFeature;`;
  if (!s.includes(old)) throw new Error('feature cap anchor missing');
  write(p, s.replace(old, neu));
}

// #329/#330 — use graph-theoretic back edges and suppress the click after a drag/pinch survives pointerup.
{
  const p = 'js/graphview.js';
  let s = read(p);
  s = s.replace(`} from './graph-routing.js';`, `} from './graph-routing.js';
import { analyzeGraph } from './controlflow.js';`);
  s = s.replace(`  const edges = [];
  for (const b of blocks) {`, `  const successors = blocks.map(() => []);
  const rawEdges = [];
  const addRaw = (from, to, kind, label) => {
    if (to == null || to < 0) return;
    rawEdges.push({ from, to, kind, label });
    successors[from].push(to);
  };
  for (const b of blocks) {`);
  s = s.replace(`      if (ti >= 0) edges.push({ from: b.index, to: ti, kind: ti <= b.index ? 'back' : 'true', label: '成り立つ' });
      if (next != null) edges.push({ from: b.index, to: next, kind: 'false', label: '成り立たない' });`, `      if (ti >= 0) addRaw(b.index, ti, 'true', '成り立つ');
      if (next != null) addRaw(b.index, next, 'false', '成り立たない');`);
  s = s.replace(`      if (ti >= 0) edges.push({ from: b.index, to: ti, kind: ti <= b.index ? 'back' : 'jump' });`, `      if (ti >= 0) addRaw(b.index, ti, 'jump');`);
  s = s.replace(`    if (next != null) edges.push({ from: b.index, to: next, kind: 'jump' });
  }
  return { nodes, edges };`, `    if (next != null) addRaw(b.index, next, 'jump');
  }
  const truth = analyzeGraph(successors, 0);
  const back = new Set(truth.backEdges.map((e) => e.from + ':' + e.to));
  const edges = rawEdges.map((e) => back.has(e.from + ':' + e.to) ? { ...e, kind: 'back' } : e);
  return { nodes, edges };`);
  // Pointer gesture state.
  s = s.replace(`  let last = null;`, `  let last = null;
  let suppressClick = false;`);
  s = s.replace(`      if (Math.hypot(dx, dy) > 3) last.moved = true;`, `      if (Math.hypot(dx, dy) > 3) { last.moved = true; suppressClick = true; }`);
  s = s.replace(`      const ratio = spread(points) / pinch.spread;`, `      suppressClick = true;
      const ratio = spread(points) / pinch.spread;`);
  s = s.replace(`  wrap.addEventListener('click', (e) => {
    if (last && last.moved) { e.stopPropagation(); e.preventDefault(); }
  }, true);`, `  wrap.addEventListener('click', (e) => {
    if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; }
  }, true);`);
  write(p, s);
}

// #331/#332 — bounded local plugin reads and strict debugger argument parsing.
{
  const p = 'js/plugins.js';
  let s = read(p);
  s = s.replace(`const MAX_SOURCE = 512 * 1024;`, `export const MAX_SOURCE = 512 * 1024;`);
  write(p, s);
}
{
  const p = 'js/tools.js';
  let s = read(p);
  // plugins.js is already imported in this module through app wiring; importing the cap is dependency-safe.
  const importAnchor = `import { runScript } from './script.js';`;
  if (s.includes(importAnchor) && !s.includes(`MAX_SOURCE`)) s = s.replace(importAnchor, importAnchor + `\nimport { MAX_SOURCE as MAX_PLUGIN_SOURCE } from './plugins.js';`);
  else if (!s.includes(`MAX_PLUGIN_SOURCE`)) {
    const firstImportEnd = s.indexOf('\n', s.indexOf('import '));
    s = s.slice(0, firstImportEnd + 1) + `import { MAX_SOURCE as MAX_PLUGIN_SOURCE } from './plugins.js';\n` + s.slice(firstImportEnd + 1);
  }
  s = s.replace(`        const f = picker.files && picker.files[0];
        if (!f) return;
        const text = await f.text();
        confirmInstall(text, f.name);`, `        const f = picker.files && picker.files[0];
        if (!f) return;
        if (f.size > MAX_PLUGIN_SOURCE) { toast('プラグインが大きすぎます（512 KB まで）。'); return; }
        const text = await f.text();
        if (new TextEncoder().encode(text).byteLength > MAX_PLUGIN_SOURCE) { toast('プラグインが大きすぎます（512 KB まで）。'); return; }
        confirmInstall(text, f.name);`);
  const startAnchor = `  const start = () => {
    args = argInputs.map((n) => {
      const v = n.value.trim();
      try { return v ? BigInt(v) : 0n; } catch { return 0n; }
    });`;
  const startReplacement = `  const start = () => {
    let parsed;
    try {
      parsed = parseDebuggerArguments(argInputs.map((n) => n.value));
      for (const n of argInputs) { n.setCustomValidity(''); n.classList.remove('invalid'); }
    } catch (error) {
      const index = Number(error.index);
      const field = argInputs[index];
      if (field) { field.setCustomValidity(error.message); field.classList.add('invalid'); field.reportValidity(); field.focus(); }
      status.textContent = '引数の入力が不正です。実行は開始していません。';
      return false;
    }
    args = parsed;`;
  if (!s.includes(startAnchor)) throw new Error('debugger start anchor missing');
  s = s.replace(startAnchor, startReplacement);
  const helperAnchor = `function hexBig(v) {`;
  const helper = `export function parseDebuggerArguments(values) {
  return Array.from(values || []).map((raw, index) => {
    const text = String(raw ?? '').trim();
    if (!text) return 0n;
    if (!/^-?(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(text)) {
      const error = new Error('x' + index + ' は10進整数または0x付き16進整数で入力してください。');
      error.index = index; error.code = 'invalid-debugger-argument'; throw error;
    }
    try { return BigInt(text); }
    catch {
      const error = new Error('x' + index + ' の整数が大きすぎるか不正です。');
      error.index = index; error.code = 'invalid-debugger-argument'; throw error;
    }
  });
}

`;
  if (!s.includes(helperAnchor)) throw new Error('hexBig helper anchor missing');
  s = s.replace(helperAnchor, helper + helperAnchor);
  write(p, s);
}

// #333 — cluster-only vendor guesses are weak inference, never hard taint/FACT.
{
  const p = 'js/vendors.js';
  let s = read(p);
  s = s.replace(`export function vendorConflicts(goalId, vendor) {
  if (!vendor) return false;
  if (!GAME_VALUE_GOALS.has(goalId)) return false;
  return true;
}`, `export function vendorConflicts(goalId, vendor) {
  if (!vendor) return false;
  if (!GAME_VALUE_GOALS.has(goalId)) return false;
  if (vendor.confidence === 'low' || vendor.via === 'cluster') return false;
  return true;
}`);
  write(p, s);
}
{
  const p = 'js/rank.js';
  let s = read(p);
  s = s.replace(`  VENDOR: 'vendor',                // 組み込んだ SDK のもので、ゲームの数値ではない`, `  VENDOR: 'vendor',                // 独立証拠で確認した SDK。low-confidence cluster は hard penalty に使わない`);
  s = s.replace(`  [REASON.VENDOR]: 'fact',          // 名前に SDK 名が入っていること自体は事実`, `  [REASON.VENDOR]: 'inference',     // vendor attribution is derived; direct name/string evidence is retained in detail`);
  const loop = `    if (!vendor) continue;
    c.vendor = vendor;
    if (!vendorConflicts(goal.id, vendor)) continue;`;
  const replacement = `    if (!vendor) continue;
    c.vendor = vendor;
    if (vendor.confidence === 'low' || vendor.via === 'cluster') {
      c.vendorInference = { ...vendor, hardTaint: false };
      continue;
    }
    if (!vendorConflicts(goal.id, vendor)) continue;`;
  if (!s.includes(loop)) throw new Error('rank vendor loop missing');
  s = s.replace(loop, replacement);
  write(p, s);
}

console.log('issues 322-333 patches applied');
