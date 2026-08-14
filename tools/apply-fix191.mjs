import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, text) { fs.writeFileSync(path, text); }
function replaceOnce(path, before, after) {
  const text = read(path);
  if (!text.includes(before)) throw new Error(`anchor not found in ${path}: ${before.slice(0, 100)}`);
  if (text.indexOf(before) !== text.lastIndexOf(before)) throw new Error(`anchor not unique in ${path}: ${before.slice(0, 100)}`);
  write(path, text.replace(before, after));
}

// #239 #240 #242 #243: deterministic, verified, streaming patch application.
{
  const path = 'js/patch.js';
  const text = read(path);
  const start = text.indexOf('export class PatchSet {');
  const end = text.indexOf('/* ── 小さなアセンブラ', start);
  if (start < 0 || end < 0) throw new Error('PatchSet anchors missing');
  const replacement = `export class PatchSet {
  constructor() {
    this.items = new Map();
  }

  get size() { return this.items.size; }

  add(fileOffset, before, after, meta) {
    const offset = canonicalOffset(fileOffset);
    const expected = Uint8Array.from(before || []);
    const replacement = Uint8Array.from(after || []);
    if (!expected.length && !replacement.length) throw new Error('空のパッチは登録できません。');
    if (expected.length !== replacement.length && expected.length === 0) {
      throw new Error('可変長パッチには検証用の元バイトが必要です。');
    }
    const item = Object.assign({ offset, before: expected, after: replacement }, meta || {});
    const key = offset.toString();
    if (this.items.has(key)) throw new Error('同じ位置には既にパッチがあります: +' + offset.toString(16));
    for (const existing of this.items.values()) {
      if (patchesOverlap(existing, item)) {
        throw new Error('既存パッチと範囲が重なっています: +' + offset.toString(16));
      }
    }
    this.items.set(key, item);
    return item;
  }

  remove(fileOffset) { this.items.delete(canonicalOffset(fileOffset).toString()); }
  clear() { this.items.clear(); }
  list() { return Array.from(this.items.values()).sort((a, b) => a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0); }
  at(fileOffset) { return this.items.get(canonicalOffset(fileOffset).toString()) || null; }

  byAddress(addr) {
    const wanted = canonicalAddress(addr);
    if (wanted == null) return null;
    for (const it of this.items.values()) {
      if (it.addr != null && canonicalAddress(it.addr) === wanted) return it;
    }
    return null;
  }

  async apply(file) {
    if (!file || typeof file.slice !== 'function' || !Number.isSafeInteger(file.size)) throw new Error('有効なFile/Blobが必要です。');
    const size = BigInt(file.size);
    const parts = [];
    let cursor = 0n;
    for (const it of this.list()) {
      const start = it.offset;
      const end = start + BigInt(it.before.length);
      if (start < cursor || start < 0n || end > size) throw new Error('書き換え位置がファイルの範囲外です: +' + start.toString(16));
      await verifyBlobBytes(file, start, it.before);
      if (start > cursor) parts.push(file.slice(Number(cursor), Number(start)));
      if (it.after.length) parts.push(it.after);
      cursor = end;
    }
    if (cursor < size) parts.push(file.slice(Number(cursor), file.size));
    return new Blob(parts, { type: 'application/octet-stream' });
  }
}

function canonicalOffset(value) {
  let n;
  try { n = typeof value === 'bigint' ? value : BigInt(value); }
  catch { throw new Error('パッチ位置が不正です。'); }
  if (n < 0n) throw new Error('パッチ位置が不正です。');
  return n;
}

function canonicalAddress(value) {
  if (value == null) return null;
  try {
    const n = typeof value === 'bigint' ? value : BigInt(value);
    return n < 0n ? null : n.toString();
  } catch { return null; }
}

function patchesOverlap(a, b) {
  const as = a.offset, ae = as + BigInt(a.before.length);
  const bs = b.offset, be = bs + BigInt(b.before.length);
  if (a.before.length === 0) return bs <= as && as < be;
  if (b.before.length === 0) return as <= bs && bs < ae;
  return as < be && bs < ae;
}

async function verifyBlobBytes(file, offset, expected) {
  const CHUNK = 64 * 1024;
  for (let pos = 0; pos < expected.length; pos += CHUNK) {
    const count = Math.min(CHUNK, expected.length - pos);
    const start = Number(offset + BigInt(pos));
    const actual = new Uint8Array(await file.slice(start, start + count).arrayBuffer());
    if (actual.length !== count) throw new Error('元のバイトを検証できません: +' + offset.toString(16));
    for (let i = 0; i < count; i++) {
      if (actual[i] !== expected[pos + i]) throw new Error('元のバイトが変わっています: +' + offset.toString(16));
    }
  }
}

`;
  write(path, text.slice(0, start) + replacement + text.slice(end));
}

// #259: JSON number/integer must be finite.
replaceOnce('js/ai/validation.js',
`function typeMatches(value, type) {
  if (type === 'object') return value != null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}`,
`function typeMatches(value, type) {
  if (type === 'object') return value != null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isFinite(value) && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}`);

// #257 #258 #250: scoped proposal records, atomic approval consumption, complete stale fingerprint.
{
  const path = 'js/ai/proposals.js';
  let text = read(path);
  text = text.replace(`    this.audit = [];\n  }`, `    this.audit = [];\n    this.scopeKey = 'global';\n  }\n\n  setScope(scope = {}) {\n    this.scopeKey = JSON.stringify([scope.binaryId ?? null, scope.sessionId ?? null]);\n    return this;\n  }\n\n  _key(id) { return this.scopeKey + '\\u0000' + String(id); }`);
  text = text.replace(`    this.records.set(id, record);`, `    this.records.set(this._key(id), record);`);
  text = text.replace(`    this.approvals.set(proposal.id, token);`, `    this.approvals.set(this._key(proposal.id), token);`);
  text = text.replaceAll(`this.approvals.delete(proposal.id)`, `this.approvals.delete(this._key(proposal.id))`);
  text = text.replace(`    if (proposal.status !== 'approved' || this.approvals.get(proposal.id) !== approvalToken) throw new AIError('approval_required', 'A valid user approval token is required.');`, `    const key = this._key(proposal.id);\n    if (proposal.status !== 'approved' || this.approvals.get(key) !== approvalToken) throw new AIError('approval_required', 'A valid user approval token is required.');`);
  text = text.replace(`    if (typeof apply !== 'function') throw new AIError('tool_failed', 'No mutation adapter is available.');\n    try {\n      await apply(proposal);`, `    if (typeof apply !== 'function') throw new AIError('tool_failed', 'No mutation adapter is available.');\n    // Consume the one-shot approval before the first await. Concurrent callers can no longer pass the gate.\n    proposal.status = 'applying';\n    this.approvals.delete(key);\n    try {\n      await apply(proposal);`);
  text = text.replace(`      this.approvals.delete(this._key(proposal.id));\n    }\n  }\n\n  require(id) {`, `      this.approvals.delete(this._key(proposal.id));\n    }\n  }\n\n  require(id) {`);
  text = text.replace(`    const value = this.records.get(String(id));`, `    const value = this.records.get(this._key(id));`);
  text = text.replace(`  has(id) { return this.records.has(String(id)); }\n  get(id) { return this.records.get(String(id)) || null; }\n  all() { return Array.from(this.records.values()); }`, `  has(id) { return this.records.has(this._key(id)); }\n  get(id) { return this.records.get(this._key(id)) || null; }\n  all() {\n    const prefix = this.scopeKey + '\\u0000';\n    return Array.from(this.records.entries()).filter(([key]) => key.startsWith(prefix)).map(([, value]) => value);\n  }`);
  text = text.replace(`function fingerprint(value) {\n  const text = JSON.stringify(jsonSafe(value));`, `function fingerprint(value) {\n  const text = canonicalIdentity(value);`);
  text = text.replace(`function randomToken() {`, `function canonicalIdentity(value, seen = new WeakSet()) {\n  if (value === null) return 'null';\n  const type = typeof value;\n  if (type === 'bigint') return 'bigint:' + value.toString();\n  if (type === 'number') return Number.isFinite(value) ? 'number:' + Object.is(value, -0) ? '-0' : String(value) : 'number:' + String(value);\n  if (type === 'string') return 'string:' + JSON.stringify(value);\n  if (type === 'boolean' || type === 'undefined') return type + ':' + String(value);\n  if (type !== 'object') return type + ':' + String(value);\n  if (seen.has(value)) throw new AIError('tool_failed', 'Proposal state contains a cycle and cannot be fingerprinted safely.');\n  seen.add(value);\n  try {\n    if (ArrayBuffer.isView(value)) return value.constructor.name + ':[' + Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).join(',') + ']';\n    if (value instanceof ArrayBuffer) return 'ArrayBuffer:[' + Array.from(new Uint8Array(value)).join(',') + ']';\n    if (Array.isArray(value)) return '[' + value.map((item) => canonicalIdentity(item, seen)).join(',') + ']';\n    const keys = Object.keys(value).sort();\n    return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalIdentity(value[key], seen)).join(',') + '}';\n  } finally { seen.delete(value); }\n}\n\nfunction randomToken() {`);
  // Fix operator precedence in number canonicalization.
  text = text.replace(`if (type === 'number') return Number.isFinite(value) ? 'number:' + Object.is(value, -0) ? '-0' : String(value) : 'number:' + String(value);`, `if (type === 'number') return 'number:' + (Object.is(value, -0) ? '-0' : String(value));`);
  write(path, text);
}

// #250 #252 #253 #254: namespace evidence; immutable verified records; row-granular verification.
{
  const path = 'js/ai/evidence.js';
  let text = read(path);
  text = text.replace(`    this.records = new Map();\n    for (const evidence of initial) this.add(evidence);\n  }`, `    this.records = new Map();\n    this.scopeKey = 'global';\n    for (const evidence of initial) this.add(evidence);\n  }\n\n  setScope(scope = {}) {\n    this.scopeKey = JSON.stringify([scope.binaryId ?? null, scope.sessionId ?? null]);\n    return this;\n  }\n\n  _key(id) { return this.scopeKey + '\\u0000' + String(id); }`);
  text = text.replace(`    const previous = this.records.get(id);\n    if (previous && previous.status === 'verified' && record.status !== 'verified') record.status = 'verified';\n    this.records.set(id, { ...previous, ...record });\n    return this.records.get(id);`, `    const key = this._key(id);\n    const previous = this.records.get(key);\n    if (previous && previous.status === 'verified') {\n      // Verified evidence is immutable. A colliding ID cannot retain the badge while changing its claim/provenance.\n      return previous;\n    }\n    this.records.set(key, { ...previous, ...record });\n    return this.records.get(key);`);
  text = text.replace(`    const explicitlyVerified = output.verified === true || output.status === 'verified';\n    const created = [];\n    for (const { key, row } of factRows(output)) {`, `    const rows = factRows(output);\n    const explicitlyVerified = output.verified === true || output.status === 'verified';\n    const explicitIds = new Set((output.verifiedEvidenceIds || []).map(String));\n    const bulk = rows.length > 1 || rows.some(({ key }) => key !== 'result');\n    const created = [];\n    for (const { key, row } of rows) {`);
  text = text.replace(`      for (const sourceId of sourceIds.length ? sourceIds : [null]) {\n        const status = verifier === true && explicitlyVerified ? 'verified' : 'supported';`, `      for (const sourceId of sourceIds.length ? sourceIds : [null]) {\n        const rowVerified = verifier === true && (\n          row.verified === true || row.status === 'verified' ||\n          (sourceId != null && explicitIds.has(String(sourceId))) ||\n          (!bulk && key === 'result' && explicitlyVerified)\n        );\n        const status = rowVerified ? 'verified' : 'supported';`);
  text = text.replace(`        const verified = !!(candidate.verification && candidate.verification.verified && plan.best && String(plan.best.address) === String(candidate.address));`, `        const verification = candidate.verification || {};\n        const proven = new Set((verification.verifiedEvidenceIds || verification.evidenceIds || []).map(String));\n        const verified = !!(verification.verified && plan.best && String(plan.best.address) === String(candidate.address) && proven.has(String(sourceId)));`);
  text = text.replace(`  has(id) { return this.records.has(String(id)); }\n  get(id) { return this.records.get(String(id)) || null; }\n  all() { return Array.from(this.records.values()); }`, `  has(id) { return this.records.has(this._key(id)); }\n  get(id) { return this.records.get(this._key(id)) || null; }\n  all() {\n    const prefix = this.scopeKey + '\\u0000';\n    return Array.from(this.records.entries()).filter(([key]) => key.startsWith(prefix)).map(([, value]) => value);\n  }`);
  write(path, text);
}

// #250: namespace hypothesis records to the active binary/session too.
{
  const path = 'js/ai/hypothesis.js';
  let text = read(path);
  text = text.replace(`    this.records = new Map();\n    /* Persisted`, `    this.records = new Map();\n    this.scopeKey = 'global';\n    /* Persisted`);
  text = text.replace(`  upsert(input = {}, authority = null) {`, `  setScope(scope = {}) {\n    this.scopeKey = JSON.stringify([scope.binaryId ?? null, scope.sessionId ?? null]);\n    return this;\n  }\n\n  _key(id) { return this.scopeKey + '\\u0000' + String(id); }\n\n  upsert(input = {}, authority = null) {`);
  text = text.replace(`    const previous = this.records.get(id);`, `    const previous = this.records.get(this._key(id));`);
  text = text.replace(`    this.records.set(id, record);`, `    this.records.set(this._key(id), record);`);
  text = text.replaceAll(`this.records.get(String(id))`, `this.records.get(this._key(id))`);
  text = text.replace(`  all() { return Array.from(this.records.values()); }`, `  all() {\n    const prefix = this.scopeKey + '\\u0000';\n    return Array.from(this.records.entries()).filter(([key]) => key.startsWith(prefix)).map(([, value]) => value);\n  }`);
  write(path, text);
}

// #250 #251 #261 #264: bind stores to session/binary, reject cross-binary resume, pre-abort, guaranteed cleanup.
{
  const path = 'js/ai/runtime.js';
  let text = read(path);
  text = text.replace(`    const externalSignal = options.signal || request.signal;\n    const turnController = new AbortController();`, `    const externalSignal = options.signal || request.signal;\n    if (externalSignal?.aborted) throw new AIError('cancelled', 'AI investigation was cancelled.');\n    const turnController = new AbortController();`);
  text = text.replace(`    if (externalSignal) externalSignal.addEventListener('abort', externalAbort, { once: true });`, `    if (externalSignal) {\n      externalSignal.addEventListener('abort', externalAbort, { once: true });\n      if (externalSignal.aborted) externalAbort();\n    }`);
  text = text.replace(`    const registry = createHexToolRegistry(this.localContext, {`, `    try {\n    const registry = createHexToolRegistry(this.localContext, {`);
  text = text.replace(`    let session = request.sessionId ? await this.sessionStore.get(request.sessionId) : null;\n    if (!session) session = await this.sessionStore.create({ binaryId: request.binaryId || this.localContext.binaryId || null, mode: request.mode, style: request.style, scope: request.scope, goal: request.goal });\n    else await this.sessionStore.update(session.id, { mode: request.mode, style: request.style, scope: request.scope, goal: request.goal });`, `    const currentBinaryId = request.binaryId ?? this.localContext.binaryId ?? null;\n    let session = request.sessionId ? await this.sessionStore.get(request.sessionId) : null;\n    if (session && currentBinaryId != null && session.binaryId != null && String(session.binaryId) !== String(currentBinaryId)) {\n      throw new AIError('scope_violation', 'The requested AI session belongs to a different binary.');\n    }\n    if (!session) session = await this.sessionStore.create({ binaryId: currentBinaryId, mode: request.mode, style: request.style, scope: request.scope, goal: request.goal });\n    else await this.sessionStore.update(session.id, { mode: request.mode, style: request.style, scope: request.scope, goal: request.goal, ...(session.binaryId == null && currentBinaryId != null ? { binaryId: currentBinaryId } : {}) });\n    const storeScope = { binaryId: session.binaryId ?? currentBinaryId ?? null, sessionId: session.id };\n    this.evidenceStore.setScope?.(storeScope);\n    this.hypothesisStore.setScope?.(storeScope);\n    this.proposalStore.setScope?.(storeScope);`);
  text = text.replace(`    result.sessionId = session.id;\n    clearTimeout(deadline);\n    this.activeControllers.delete(turnController);\n    if (externalSignal) externalSignal.removeEventListener('abort', externalAbort);\n    return validateAIResult(result);\n  }`, `    result.sessionId = session.id;\n    return validateAIResult(result);\n    } finally {\n      clearTimeout(deadline);\n      this.activeControllers.delete(turnController);\n      if (externalSignal) externalSignal.removeEventListener('abort', externalAbort);\n    }\n  }`);
  write(path, text);
}

// #260 #261: bounded response streaming and pre-aborted transport.
{
  const path = 'js/ai/transport.js';
  let text = read(path);
  text = text.replace(`export async function requestJSON(url, body, { signal, timeoutMs = 30000, fetchImpl = globalThis.fetch } = {}) {\n  if (typeof fetchImpl !== 'function') throw new AIError('provider_error', 'Fetch is unavailable.');`, `export async function requestJSON(url, body, { signal, timeoutMs = 30000, maxResponseBytes = 2 * 1024 * 1024, fetchImpl = globalThis.fetch } = {}) {\n  if (typeof fetchImpl !== 'function') throw new AIError('provider_error', 'Fetch is unavailable.');\n  if (signal?.aborted) throw new AIError('cancelled', 'AI investigation was cancelled.');\n  maxResponseBytes = Math.max(1024, Math.floor(Number(maxResponseBytes) || 0));`);
  text = text.replace(`  if (signal) signal.addEventListener('abort', abort, { once: true });`, `  if (signal) { signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); }`);
  text = text.replace(`    let payload;\n    try { payload = await response.json(); }\n    catch { throw new AIError('provider_error', 'The AI service returned invalid JSON.', { status: response.status }); }`, `    let payload;\n    try { payload = await readBoundedJSON(response, maxResponseBytes); }\n    catch (error) {\n      if (error instanceof AIError) throw error;\n      throw new AIError('provider_error', 'The AI service returned invalid JSON.', { status: response.status });\n    }`);
  text += `\nasync function readBoundedJSON(response, maxBytes) {\n  const declared = Number(response.headers?.get?.('content-length'));\n  if (Number.isFinite(declared) && declared > maxBytes) throw new AIError('context_too_large', 'The AI service response exceeded the configured size limit.', { maxBytes, declared });\n  if (response.body && typeof response.body.getReader === 'function') {\n    const reader = response.body.getReader();\n    const chunks = []; let total = 0;\n    try {\n      while (true) {\n        const { done, value } = await reader.read();\n        if (done) break;\n        total += value.byteLength;\n        if (total > maxBytes) { await reader.cancel('response-too-large').catch(() => {}); throw new AIError('context_too_large', 'The AI service response exceeded the configured size limit.', { maxBytes, bytes: total }); }\n        chunks.push(value);\n      }\n    } finally { try { reader.releaseLock(); } catch {} }\n    const bytes = new Uint8Array(total); let at = 0;\n    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }\n    return JSON.parse(new TextDecoder().decode(bytes));\n  }\n  const text = await response.text();\n  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new AIError('context_too_large', 'The AI service response exceeded the configured size limit.', { maxBytes });\n  return JSON.parse(text);\n}\n`;
  write(path, text);
}

// #261: provider must fail before opening a request when already aborted.
{
  const path = 'js/ai/provider/index.js';
  let text = read(path);
  text = text.replace(`  constructor({ endpoint = '/api/ai/turn', fetchImpl = globalThis.fetch, timeoutMs = 110000 } = {}) {`, `  constructor({ endpoint = '/api/ai/turn', fetchImpl = globalThis.fetch, timeoutMs = 110000, maxResponseBytes = 2 * 1024 * 1024 } = {}) {`);
  text = text.replace(`    this.timeoutMs = timeoutMs;`, `    this.timeoutMs = timeoutMs;\n    this.maxResponseBytes = maxResponseBytes;`);
  text = text.replace(`  async nextTurn(request, options = {}) {\n    const controller = new AbortController();`, `  async nextTurn(request, options = {}) {\n    if (options.signal?.aborted) throw new AIError('cancelled', 'AI investigation was cancelled.');\n    const controller = new AbortController();`);
  text = text.replace(`    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });`, `    if (options.signal) { options.signal.addEventListener('abort', onAbort, { once: true }); if (options.signal.aborted) onAbort(); }`);
  text = text.replace(`}, { signal: controller.signal, timeoutMs: options.timeoutMs || this.timeoutMs, fetchImpl: this.fetchImpl });`, `}, { signal: controller.signal, timeoutMs: options.timeoutMs || this.timeoutMs, maxResponseBytes: this.maxResponseBytes, fetchImpl: this.fetchImpl });`);
  write(path, text);
}

// #256 #263: strict selection projection; preserve latest oversized observation as bounded metadata.
{
  const path = 'js/ai/context/broker.js';
  let text = read(path);
  text = text.replace(`    const fn = this.local.activeFunction || this.local.currentFunction;\n    if (fn) current.function = compactFunction(fn, this.maxFunctionLines);`, `    const fn = this.local.activeFunction || this.local.currentFunction;\n    if (fn && scope !== 'selection') current.function = compactFunction(fn, this.maxFunctionLines);\n    if (fn && scope === 'selection') current.containingFunction = { address: addressText(fn.address ?? fn.startAddr ?? fn.identity?.startAddr), name: fn.name || fn.identity?.name || null };`);
  const oldCompact = `function compactObservations(values, maxBytes) {\n  const out = [];\n  let used = 0;\n  for (const value of values.slice(-12).reverse()) {\n    const safe = {\n      kind: 'hex-tool-data', trust: 'untrusted-data', tool: value.tool || value.request?.tool,\n      summary: String(value.summary || '').slice(0, 3000), evidenceIds: (value.evidenceIds || []).slice(0, 100),\n      data: jsonSafe(value.data),\n    };\n    const size = byteLength(safe);\n    if (used + size > maxBytes) continue;\n    used += size; out.unshift(safe);\n  }\n  return out;\n}`;
  const newCompact = `function compactObservations(values, maxBytes) {\n  const out = [];\n  let used = 0;\n  for (const value of values.slice(-12).reverse()) {\n    let safe = {\n      kind: 'hex-tool-data', trust: 'untrusted-data', tool: value.tool || value.request?.tool,\n      summary: String(value.summary || '').slice(0, 3000), evidenceIds: (value.evidenceIds || []).slice(0, 100),\n      data: jsonSafe(value.data),\n    };\n    let size = byteLength(safe);\n    if (used + size > maxBytes) {\n      if (!out.length) {\n        safe = { kind: 'hex-tool-data', trust: 'untrusted-data', tool: safe.tool, summary: safe.summary.slice(0, 800), evidenceIds: safe.evidenceIds.slice(0, 32), truncated: true };\n        size = byteLength(safe);\n        if (size <= maxBytes) { used += size; out.unshift(safe); }\n      }\n      break; // newest data wins; never replace it with older observations.\n    }\n    used += size; out.unshift(safe);\n  }\n  return out;\n}`;
  if (!text.includes(oldCompact)) throw new Error('compactObservations anchor missing');
  text = text.replace(oldCompact, newCompact);
  write(path, text);
}

// #255 #256 #262: runtime verdict provenance, explicit selection boundary, pre-analysis work budget.
{
  const path = 'js/ai/tools/registry.js';
  let text = read(path);
  text = text.replace(`  let disassembly = 0;\n  const analysisContext`, `  let disassembly = 0;\n  let activeSignal = null;\n  const analysisContext`);
  text = text.replace(`    analyze: async (...args) => {\n      if (disassembly >= maxDisassembly) throw new Error('disassembly-budget');\n      const model = await context.analyze(...args);`, `    analyze: async (...args) => {\n      if (disassembly >= maxDisassembly) throw new Error('disassembly-budget');\n      const remaining = maxDisassembly - disassembly;\n      const last = args[args.length - 1];\n      const hasOptions = last && typeof last === 'object' && !Array.isArray(last) && !(last instanceof Uint8Array);\n      const opts = hasOptions ? { ...last } : {};\n      opts.maxInstructions = Math.min(Number.isFinite(opts.maxInstructions) ? opts.maxInstructions : remaining, remaining);\n      opts.instructionBudget = Math.min(Number.isFinite(opts.instructionBudget) ? opts.instructionBudget : remaining, remaining);\n      opts.workBudget = Math.min(Number.isFinite(opts.workBudget) ? opts.workBudget : remaining, remaining);\n      if (activeSignal && !opts.signal) opts.signal = activeSignal;\n      const callArgs = hasOptions ? [...args.slice(0, -1), opts] : [...args, opts];\n      const model = await context.analyze(...callArgs);`);
  text = text.replace(`  const functionScopes = ['auto', 'selection', 'function', 'neighborhood', 'binary', 'project'];`, `  const functionScopes = ['auto', 'function', 'neighborhood', 'binary', 'project'];`);
  text = text.replace(`  const register = (name, description, inputSchema, execute, extra = {}) => registry.register({ name, description, inputSchema, execute, ...extra });`, `  const register = (name, description, inputSchema, execute, extra = {}) => registry.register({\n    name, description, inputSchema, ...extra,\n    execute: async (args, executionOptions = {}) => {\n      const previousSignal = activeSignal; activeSignal = executionOptions.signal || null;\n      try { return await execute(args, executionOptions); } finally { activeSignal = previousSignal; }\n    },\n  });`);
  text = text.replace(`  }, { cost: 'medium', scopeSupport: allReadScopes });\n  register('get_selection_context'`, `  }, { cost: 'medium', scopeSupport: functionScopes });\n  register('get_selection_context'`);
  text = text.replace(`  const evidence = (session?.evidence || session?.observations || []).slice(-limit);\n  return { results: evidence, returned: evidence.length, verified: evidence.length > 0 };`, `  const evidence = (session?.evidence || session?.observations || []).slice(-limit).map((row) => ({ ...row, verified: runtimeObservationVerified(row) }));\n  return { results: evidence, returned: evidence.length, verifiedEvidenceIds: evidence.filter((row) => row.verified).map((row) => row.id).filter(Boolean) };`);
  text = text.replace(`async function runtimeVerify(context, hypothesis, options) {`, `function runtimeObservationVerified(row) {\n  return !!(row && (row.verified === true || row.status === 'verified') && (row.replayId || row.verificationId || row.provenance?.verified === true));\n}\n\nasync function runtimeVerify(context, hypothesis, options) {`);
  write(path, text);
}

// #246 #247: keyboard-correct tabs and virtual focus restoration.
{
  const path = 'js/ui/primitives.js';
  let text = read(path);
  const oldTabs = `export function tabs(items, active, onChange) {\n  const root = h('div', 'ui-tabs');\n  root.setAttribute('role', 'tablist');\n  for (const item of items) {\n    const selected = item.id === active;\n    const b = uiButton(item.label, {\n      cls: 'ui-tab' + (selected ? ' active' : ''),\n      onClick: () => onChange(item.id),\n    });\n    b.setAttribute('role', 'tab');\n    b.setAttribute('aria-selected', String(selected));\n    b.tabIndex = selected ? 0 : -1;\n    root.append(b);\n  }\n  return root;\n}`;
  const newTabs = `export function tabs(items, active, onChange, { orientation = 'horizontal' } = {}) {\n  const root = h('div', 'ui-tabs');\n  root.setAttribute('role', 'tablist');\n  root.setAttribute('aria-orientation', orientation);\n  const buttons = [];\n  const activate = (index, { focus = false } = {}) => {\n    if (index < 0 || index >= buttons.length) return;\n    buttons.forEach((button, i) => {\n      const selected = i === index;\n      button.tabIndex = selected ? 0 : -1;\n      button.setAttribute('aria-selected', String(selected));\n      button.classList.toggle('active', selected);\n    });\n    if (focus) buttons[index].focus();\n    onChange(items[index].id);\n  };\n  items.forEach((item, index) => {\n    const selected = item.id === active;\n    const b = uiButton(item.label, { cls: 'ui-tab' + (selected ? ' active' : ''), onClick: () => activate(index) });\n    b.setAttribute('role', 'tab');\n    b.setAttribute('aria-selected', String(selected));\n    b.tabIndex = selected ? 0 : -1;\n    if (item.panelId) b.setAttribute('aria-controls', item.panelId);\n    if (item.tabId) b.id = item.tabId;\n    buttons.push(b); root.append(b);\n  });\n  root.addEventListener('keydown', (event) => {\n    const index = buttons.indexOf(event.target);\n    if (index < 0) return;\n    let next = index;\n    if (event.key === 'Home') next = 0;\n    else if (event.key === 'End') next = buttons.length - 1;\n    else if (orientation === 'vertical' && event.key === 'ArrowDown') next = (index + 1) % buttons.length;\n    else if (orientation === 'vertical' && event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;\n    else if (orientation !== 'vertical' && event.key === 'ArrowRight') next = (index + 1) % buttons.length;\n    else if (orientation !== 'vertical' && event.key === 'ArrowLeft') next = (index - 1 + buttons.length) % buttons.length;\n    else return;\n    event.preventDefault(); activate(next, { focus: true });\n  });\n  return root;\n}`;
  if (!text.includes(oldTabs)) throw new Error('tabs anchor missing');
  text = text.replace(oldTabs, newTabs);
  text = text.replace(`    this.window.replaceChildren(frag);\n    this.window.style.transform`, `    const active = document.activeElement;\n    const activeRow = active && active.closest ? active.closest('.ui-virtual-row') : null;\n    const activeIndex = activeRow ? activeRow.dataset.virtualIndex : null;\n    const activePath = activeRow && activeRow.contains(active) ? childPath(activeRow, active) : null;\n    for (const row of frag.childNodes) row.dataset.virtualIndex = String(first + Array.prototype.indexOf.call(frag.childNodes, row));\n    this.window.replaceChildren(frag);\n    if (activeIndex != null) {\n      const row = Array.from(this.window.children).find((node) => node.dataset.virtualIndex === activeIndex);\n      const target = row && activePath ? childAtPath(row, activePath) : row;\n      if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });\n    }\n    this.window.style.transform`);
  text += `\nfunction childPath(root, node) {\n  const path = []; let current = node;\n  while (current && current !== root) {\n    const parent = current.parentNode; if (!parent) return null;\n    path.unshift(Array.prototype.indexOf.call(parent.childNodes, current)); current = parent;\n  }\n  return current === root ? path : null;\n}\nfunction childAtPath(root, path) {\n  let node = root;\n  for (const index of path) { node = node?.childNodes?.[index]; if (!node) return null; }\n  return node;\n}\n`;
  write(path, text);
}

// #248: invalid Itanium substitution is a parse failure, never an invented auto type.
replaceOnce('js/rtti.js', `  const n = idx === '' ? 0 : parseInt(idx, 36) + 1;\n  return p.subs[n] || 'auto';`, `  const n = idx === '' ? 0 : parseInt(idx, 36) + 1;\n  if (!Number.isInteger(n) || n < 0 || n >= p.subs.length) throw new Error('invalid-substitution');\n  return p.subs[n];`);

// #249: the minimal Swift label parser never claims an unparsed suffix is an exact demangle.
{
  const path = 'js/swift.js';
  let text = read(path);
  text = text.replace(`  const demangled = components.length ? components.join('.') + (async ? ' async' : '') + (throws ? ' throws' : '') : original;\n  return { original, demangled, parsed: components.length > 0, components, suffix, async, throws, accessor };`, `  const partialDemangled = components.length ? components.join('.') + (async ? ' async' : '') + (throws ? ' throws' : '') : null;\n  const exact = components.length > 0 && suffix.length === 0;\n  // This built-in parser understands length-prefixed components only. A trailing grammar record is partial/unsupported, never an exact identity.\n  const demangled = exact ? partialDemangled : original;\n  return { original, demangled, parsed: exact, exact, partial: !!partialDemangled && !exact, partialDemangled, components, suffix, async: exact && async, throws: exact && throws, accessor: exact ? accessor : null };`);
  write(path, text);
}

console.log('issue 191+ source patches applied');
