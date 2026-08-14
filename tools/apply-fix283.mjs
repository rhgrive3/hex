import fs from 'node:fs';
const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p,s) => fs.writeFileSync(p,s);
function rep(p,a,b){ const s=read(p); if(!s.includes(a)) throw new Error(`anchor missing ${p}: ${a.slice(0,100)}`); write(p,s.replace(a,b)); }

// #283/#284 — persist user plugins per source package and keep stable, monotonic IDs.
{
  const p='js/plugins.js'; let s=read(p);
  const start=s.indexOf('export class PluginHost {');
  const end=s.indexOf('\nexport const EXAMPLE_PLUGIN', start);
  if(start<0||end<0) throw new Error('PluginHost anchors missing');
  const cls=`export class PluginHost {
  constructor(app) {
    this.app = app;
    this.plugins = [];
    this.packages = [];
    this.nextId = 1;
    this.nextPackageId = 1;
    this.ready = this.load();
  }

  async load() {
    let raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch { return; }
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && !Array.isArray(parsed) && parsed.version >= 2) {
        this.nextId = Math.max(1, Number(parsed.nextId) || 1);
        this.nextPackageId = Math.max(1, Number(parsed.nextPackageId) || 1);
        for (const pkg of parsed.packages || []) {
          if (!pkg || typeof pkg.source !== 'string') continue;
          await this.install(pkg.source, pkg.origin || '保存されたもの', { silent: true, restore: pkg });
        }
        return;
      }
      // Legacy storage saved one record per expanded definition. Deduplicate the source
      // before discovery so an old 2-definition package cannot become 4/8/... entries.
      const seen = new Set();
      for (const item of Array.isArray(parsed) ? parsed : []) {
        if (!item || typeof item.source !== 'string') continue;
        const key = item.source + '\\u0000' + String(item.origin || '');
        if (seen.has(key)) continue;
        seen.add(key);
        await this.install(item.source, item.origin || '保存されたもの', { silent: true });
      }
      this.save();
    } catch { /* corrupted plugin storage is isolated */ }
  }

  save() {
    const payload = {
      version: 2,
      nextId: this.nextId,
      nextPackageId: this.nextPackageId,
      packages: this.packages.map((pkg) => ({
        packageId: pkg.packageId, source: pkg.source, origin: pkg.origin,
        definitions: pkg.definitions.map((d) => ({ id: d.id, index: d.index })),
      })),
    };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(payload)); return true; }
    catch { return false; }
  }

  async install(source, origin, opts = {}) {
    if (typeof source !== 'string' || !source.trim()) return { error: '中身が空です。' };
    if (source.length > MAX_SOURCE) return { error: 'プラグインが大きすぎます（512 KB まで）。' };
    const discovered = await runInSandbox({ source, mode: 'discover', api: Object.create(null), out: () => {}, timeout: 10000 });
    if (discovered.error) return { error: '読み込めませんでした: ' + discovered.error };
    const defs = discovered.value || [];
    const restore = opts.restore || null;
    const wanted = restore && Array.isArray(restore.definitions)
      ? restore.definitions.filter((d) => Number.isInteger(d.index) && d.index >= 0 && d.index < defs.length)
      : defs.map((_def, index) => ({ index, id: null }));
    const packageId = restore?.packageId || ('pkg' + this.nextPackageId++);
    const added = wanted.map((saved) => {
      const def = defs[saved.index];
      let id = saved.id ? String(saved.id) : null;
      if (!id || this.plugins.some((x) => x.id === id)) id = 'p' + this.nextId++;
      const numeric = /^p(\\d+)$/.exec(id);
      if (numeric) this.nextId = Math.max(this.nextId, Number(numeric[1]) + 1);
      return { id, name: def.name, description: def.description, index: saved.index, source, origin: origin || '不明', packageId };
    });
    if (!added.length) return { error: 'プラグインが 1 つも登録されませんでした（hex.plugin({…}) を呼んでください）。' };
    this.plugins.push(...added);
    this.packages.push({ packageId, source, origin: origin || '不明', definitions: added.map((x) => ({ id: x.id, index: x.index })) });
    if (!opts.silent) this.save();
    return { ok: true, added };
  }

  async installFromUrl(url) {
    let text;
    try {
      const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) return { error: '取り寄せられませんでした（' + res.status + '）。' };
      text = await res.text();
    } catch (err) { return { error: '取り寄せに失敗しました: ' + ((err && err.message) || err) }; }
    if (text.length > MAX_SOURCE) return { error: 'プラグインが大きすぎます（512 KB まで）。' };
    return { ok: true, source: text, origin: url, needsConfirmation: true };
  }

  remove(id) {
    const target = this.plugins.find((p) => p.id === id);
    if (!target) return false;
    this.plugins = this.plugins.filter((p) => p.id !== id);
    const pkg = this.packages.find((p) => p.packageId === target.packageId);
    if (pkg) pkg.definitions = pkg.definitions.filter((d) => d.id !== id);
    this.packages = this.packages.filter((p) => p.definitions.length);
    this.save();
    return true;
  }
  clear() { this.plugins = []; this.packages = []; this.save(); }

  async run(id, out) {
    const p = this.plugins.find((x) => x.id === id);
    if (!p) return { error: 'そのプラグインが見つかりません。' };
    const { api, print, invoke } = createApi(this.app, out);
    return runInSandbox({ source: p.source, mode: 'plugin', index: p.index, api, invoke,
      out: (...args) => print(...args) });
  }
}
`;
  write(p,s.slice(0,start)+cls+s.slice(end));
}

// #285 — make the trusted API invocation abortable and cancel backend requests started by this RPC.
{
  const p='js/script.js'; let s=read(p);
  const anchor=`  return { api, print };\n}`;
  if(!s.includes(anchor)) throw new Error('createApi return anchor missing');
  const repl=`  const invoke = async (method, args = [], signal = null) => {
    const fn = api[method];
    if (typeof fn !== 'function') throw new Error('許可されていないAPIです: ' + method);
    if (signal?.aborted) throw new DOMException('Sandbox operation aborted.', 'AbortError');
    const before = new Set(app.backend?.pending ? app.backend.pending.keys() : []);
    const cancelOwned = () => {
      if (!app.backend?.pending || typeof app.backend.cancel !== 'function') return;
      for (const id of app.backend.pending.keys()) if (!before.has(id)) app.backend.cancel(id);
    };
    let value;
    try { value = fn(...args); }
    catch (error) { throw error; }
    return await abortableHost(value, signal, cancelOwned);
  };

  return { api, print, invoke };
}`;
  s=s.replace(anchor,repl);
  const helper=`\nfunction abortableHost(value, signal, cancel) {
  if (!value || typeof value.then !== 'function') return Promise.resolve(value);
  if (!signal) return Promise.resolve(value);
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (done) return;
      done = true;
      try { if (typeof value.cancel === 'function') value.cancel(); } catch {}
      try { cancel?.(); } catch {}
      cleanup();
      reject(new DOMException('Sandbox operation aborted.', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    Promise.resolve(value).then((v) => { if (!done) { done = true; cleanup(); resolve(v); } }, (e) => { if (!done) { done = true; cleanup(); reject(e); } });
  });
}\n`;
  const runAnchor=`/** app からエミュレータを作る（画面側でも使う）。 */`;
  if(!s.includes(runAnchor)) throw new Error('script helper anchor missing');
  s=s.replace(runAnchor,helper+'\n'+runAnchor);
  s=s.replace(`  const { api, print } = createApi(app, out);\n  return runInSandbox({ source: code, mode: 'script', api, out: (...args) => print(...args) });`,
`  const { api, print, invoke } = createApi(app, out);\n  return runInSandbox({ source: code, mode: 'script', api, invoke, out: (...args) => print(...args) });`);
  write(p,s);
}

// #285/#286 — per-run AbortController plus hard RPC concurrency/count/byte/heavy budgets.
{
  const p='js/sandbox.js'; let s=read(p);
  const start=s.indexOf('export function runInSandbox(');
  if(start<0) throw new Error('runInSandbox anchor missing');
  const replacement=`export function runInSandbox({ source, mode = 'script', index = 0, api, invoke = null, out, timeout = 30000, budgets = {} }) {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.referrerPolicy = 'no-referrer';
    const channel = new MessageChannel();
    const controller = new AbortController();
    let settled = false;
    let rpcTotal = 0, rpcActive = 0, heavyActive = 0, responseBytes = 0;
    const maxRpc = Math.max(1, Math.min(10000, Number(budgets.maxRpc) || 1000));
    const maxConcurrent = Math.max(1, Math.min(128, Number(budgets.maxConcurrent) || 32));
    const maxHeavyConcurrent = Math.max(1, Math.min(8, Number(budgets.maxHeavyConcurrent) || 2));
    const maxRequestBytes = Math.max(1024, Math.min(8 * 1024 * 1024, Number(budgets.maxRequestBytes) || 1024 * 1024));
    const maxResponseBytes = Math.max(4096, Math.min(64 * 1024 * 1024, Number(budgets.maxResponseBytes) || 8 * 1024 * 1024));
    const heavy = new Set(['decompile','types','struct','run','emulatorRun','loadStrings','disasm','bytes','string']);
    const byteSize = (value) => {
      try { return new TextEncoder().encode(JSON.stringify(value, (_k,v) => typeof v === 'bigint' ? v.toString() : v)).byteLength; }
      catch { return maxRequestBytes + 1; }
    };

    const terminate = () => { try { channel.port1.postMessage({ t: 'terminate' }); } catch {} };
    const onFrameReady = (event) => {
      if (event.source !== frame.contentWindow || !event.data || event.data.t !== 'hexSandboxFrameReady') return;
      window.removeEventListener('message', onFrameReady);
      frame.contentWindow.postMessage({ t: 'init' }, '*', [channel.port2]);
    };
    window.addEventListener('message', onFrameReady);

    const finish = (value) => {
      if (settled) return;
      settled = true;
      controller.abort('sandbox-finished');
      clearTimeout(timer);
      window.removeEventListener('message', onFrameReady);
      terminate();
      channel.port1.close();
      frame.remove();
      resolve(value);
    };
    const failBudget = (message) => finish({ error: '安全制限: ' + message });
    const timer = setTimeout(() => finish({ error: '実行が時間制限を超えたため、安全に停止しました。' }), Math.max(50, Number(timeout) || 30000));

    channel.port1.onmessage = async (e) => {
      if (settled) return;
      const m = e.data || {};
      if (m.t === 'ready') {
        channel.port1.postMessage({ t: 'start', source: String(source || ''), mode, index });
      } else if (m.t === 'print') {
        try { out(...(m.args || [])); } catch {}
      } else if (m.t === 'rpc') {
        rpcTotal++;
        if (rpcTotal > maxRpc) { failBudget('API呼び出し回数の上限を超えました。'); return; }
        if (rpcActive >= maxConcurrent) { failBudget('同時API呼び出し数の上限を超えました。'); return; }
        const inputBytes = byteSize(m.args || []);
        if (inputBytes > maxRequestBytes) { failBudget('API入力サイズの上限を超えました。'); return; }
        const isHeavy = heavy.has(String(m.method || ''));
        if (isHeavy && heavyActive >= maxHeavyConcurrent) { failBudget('重いAPIの同時実行上限を超えました。'); return; }
        rpcActive++; if (isHeavy) heavyActive++;
        let value, error;
        try {
          const allowed = api && typeof m.method === 'string' && Object.prototype.hasOwnProperty.call(api, m.method);
          const fn = allowed ? api[m.method] : null;
          if (typeof fn !== 'function') throw new Error('許可されていないAPIです: ' + m.method);
          value = invoke ? await invoke(m.method, m.args || [], controller.signal) : await fn(...(m.args || []), { signal: controller.signal });
          const bytes = byteSize(value);
          responseBytes += bytes;
          if (responseBytes > maxResponseBytes) { failBudget('API結果サイズの総上限を超えました。'); return; }
        } catch (err) { error = (err && err.message) || String(err); }
        finally { rpcActive--; if (isHeavy) heavyActive--; }
        if (settled) return;
        try { channel.port1.postMessage({ t: 'rpcResult', id: m.id, value, error }); }
        catch { channel.port1.postMessage({ t: 'rpcResult', id: m.id, error: '結果を受け渡せませんでした。' }); }
      } else if (m.t === 'done') finish({ ok: true, value: m.value });
      else if (m.t === 'error') finish({ error: m.error || '実行できませんでした。' });
    };
    frame.srcdoc = FRAME;
    document.body.append(frame);
  });
}
`;
  write(p,s.slice(0,start)+replacement);
}

// #287 — search UTF-8 bytes, retaining ASCII-only case folding and byte-boundary carry.
rep('js/worker.js',
`    // ASCII の文字列として探す。大文字小文字は区別しない。
    const needle = String(query || '');
    if (!needle) throw new Error('Enter text to search for.');
    const pat = new Uint8Array(needle.length);
    for (let i = 0; i < needle.length; i++) pat[i] = needle.charCodeAt(i) & 0xff;
    const lower = (b) => (b >= 65 && b <= 90 ? b + 32 : b);
    for (let i = 0; i < pat.length; i++) pat[i] = lower(pat[i]);`,
`    // Search the actual UTF-8 representation. ASCII bytes remain case-insensitive;
    // non-ASCII bytes are compared exactly, so Japanese/emoji work across chunks.
    const needle = String(query || '');
    if (!needle) throw new Error('Enter text to search for.');
    const pat = new TextEncoder().encode(needle);
    const lower = (b) => (b >= 65 && b <= 90 ? b + 32 : b);
    for (let i = 0; i < pat.length; i++) pat[i] = lower(pat[i]);`);

// #288 — data pointers are candidates, not proof. Only promote candidates with independent instruction evidence.
{
  const p='js/worker.js'; let s=read(p);
  const anchor=`  const dataCandidates = new Set();`;
  if(!s.includes(anchor)) throw new Error('dataCandidates anchor missing');
  s=s.replace(anchor, anchor+`\n  const dataInstructionConfirmed = new Set();`);
  const scanAnchor=`      const currentKind = Words.classifyWord(w);`;
  if(!s.includes(scanAnchor)) throw new Error('guessFunctions instruction anchor missing');
  s=s.replace(scanAnchor, scanAnchor+`\n      if (dataCandidates.has(pc) && (looksLikePrologue(w) || Words.isRet(w))) dataInstructionConfirmed.add(pc);`);
  const final=`  for (const a of dataCandidates) {
    if (found.size >= cap) break;
    if (suppressIndirectFallthrough && indirectFallthroughData.has(a) && !found.has(a)) continue;
    found.add(a);
  }`;
  const safer=`  for (const a of dataCandidates) {
    if (found.size >= cap) break;
    if (found.has(a)) continue; // already independently confirmed by unwind/call/prologue/tiny-function rules.
    if (suppressIndirectFallthrough && indirectFallthroughData.has(a)) continue;
    if (!dataInstructionConfirmed.has(a)) continue;
    found.add(a);
  }`;
  if(!s.includes(final)) throw new Error('guessFunctions final promotion anchor missing');
  s=s.replace(final,safer);
  write(p,s);
}

// #289 — direct xref ADRP state cannot survive control-flow boundaries or an intervening register definition.
{
  const p='js/worker.js'; let s=read(p);
  const marker=`      const rel = pcRelTarget(w, pc);`;
  const at=s.indexOf(marker, s.indexOf('async function findXrefs'));
  if(at<0) throw new Error('findXrefs rel anchor missing');
  const guard=`      // ADRP provenance is basic-block local. Calls/branches end the chain.
      if (Words.isCallImm(w) || Words.isIndirectCall(w) || Words.isBranchImm(w) || Words.isCondBranch(w) || Words.isRet(w) || Words.isBr(w)) {
        pageOf.fill(null); pageAt.fill(-1);
      }
`;
  s=s.slice(0,at)+guard+s.slice(at);
  const pairContinue=`        if (!pair.load && !pair.store) { pageOf[pair.rd] = full; pageAt[pair.rd] = index; }
      }
    }
    pos += words * 4;`;
  const withInvalidation=`        if (!pair.load && !pair.store) { pageOf[pair.rd] = full; pageAt[pair.rd] = index; }
        continue;
      }
      // Any other low-register definition kills a previously tracked page.
      if (WRITES_LOW_REG[kind]) {
        const d = w & 0x1f;
        if (pageAt[d] >= 0) { pageOf[d] = null; pageAt[d] = -1; }
      }
    }
    pos += words * 4;`;
  const after=s.indexOf(pairContinue, at);
  if(after<0) throw new Error('findXrefs pair tail anchor missing');
  s=s.slice(0,after)+s.slice(after).replace(pairContinue,withInvalidation);
  write(p,s);
}

// #290 — PAV isotonic regression makes the calibration curve monotone.
rep('js/calib.js',
`  const curve = bins.filter((b) => b.n >= 3)
    .map((b) => ({ score: b.confidence, observed: b.accuracy, n: b.n }))
    .sort((a, b) => a.score - b.score);
  return curve.length >= 3 ? curve : null;`,
`  const curve = bins.filter((b) => b.n >= 3)
    .map((b) => ({ score: b.confidence, observed: b.accuracy, n: b.n }))
    .sort((a, b) => a.score - b.score);
  if (curve.length < 3) return null;
  const blocks = [];
  for (const point of curve) {
    blocks.push({ points: [point], weight: point.n, value: point.observed * point.n });
    while (blocks.length >= 2) {
      const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
      if (a.value / a.weight <= b.value / b.weight) break;
      blocks.splice(blocks.length - 2, 2, { points: a.points.concat(b.points), weight: a.weight + b.weight, value: a.value + b.value });
    }
  }
  for (const block of blocks) {
    const observed = block.value / block.weight;
    for (const point of block.points) point.observed = observed;
  }
  return curve;`);

// #292 — expand references for every matched string; expose source-index completeness explicitly.
{
  const p='js/rank.js'; let s=read(p);
  s=s.replace(`  const USE_STRINGS = 300;      // 濃いものから順に、この数まで参照元をたどる\n  let referenced = 0;\n  for (const ms of matchedStrings.slice(0, USE_STRINGS)) {`,
`  let referenced = 0;\n  for (const ms of matchedStrings) {`);
  s=s.replace(`    matchedStrings,\n    notes,\n    total: out.length,`, `    matchedStrings,\n    stringEvidenceComplete: hasProgram ? !program.refsCapped : false,\n    notes,\n    total: out.length,`);
  write(p,s);
}

console.log('issues 283-292 platform patches applied');
