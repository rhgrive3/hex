import { deepFreeze, stableDigest } from '../core/identity/index.js';
import { createResourceBudget } from '../phase12/resource-budget.js';

export const PATTERN_LANGUAGE_VERSION = 'hex-pattern-language-v1';
const PRIMITIVES = new Map([
  ['u8', { bytes: 1, read: (view, offset) => view.getUint8(offset) }], ['i8', { bytes: 1, read: (view, offset) => view.getInt8(offset) }],
  ['u16le', { bytes: 2, read: (view, offset) => view.getUint16(offset, true) }], ['u16be', { bytes: 2, read: (view, offset) => view.getUint16(offset, false) }],
  ['i16le', { bytes: 2, read: (view, offset) => view.getInt16(offset, true) }], ['i16be', { bytes: 2, read: (view, offset) => view.getInt16(offset, false) }],
  ['u32le', { bytes: 4, read: (view, offset) => view.getUint32(offset, true) }], ['u32be', { bytes: 4, read: (view, offset) => view.getUint32(offset, false) }],
  ['i32le', { bytes: 4, read: (view, offset) => view.getInt32(offset, true) }], ['i32be', { bytes: 4, read: (view, offset) => view.getInt32(offset, false) }],
  ['u64le', { bytes: 8, read: (view, offset) => view.getBigUint64(offset, true) }], ['u64be', { bytes: 8, read: (view, offset) => view.getBigUint64(offset, false) }],
  ['i64le', { bytes: 8, read: (view, offset) => view.getBigInt64(offset, true) }], ['i64be', { bytes: 8, read: (view, offset) => view.getBigInt64(offset, false) }],
  ['f32le', { bytes: 4, read: (view, offset) => view.getFloat32(offset, true) }], ['f32be', { bytes: 4, read: (view, offset) => view.getFloat32(offset, false) }],
  ['f64le', { bytes: 8, read: (view, offset) => view.getFloat64(offset, true) }], ['f64be', { bytes: 8, read: (view, offset) => view.getFloat64(offset, false) }],
]);

function text(value) { return String(value ?? ''); }
function list(value) { return Array.isArray(value) ? value : []; }
function tokenize(source) {
  const tokens = []; let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) { i++; continue; }
    if (source.startsWith('//', i)) { const end = source.indexOf('\n', i + 2); i = end < 0 ? source.length : end + 1; continue; }
    const char = source[i];
    if ('{}[]():;,*<>'.includes(char)) { tokens.push({ type: char, value: char }); i++; continue; }
    if (char === '"' || char === "'") { const quote = char; let value = ''; i++; while (i < source.length && source[i] !== quote) { if (source[i] === '\\') { i++; if (i >= source.length) throw new SyntaxError('pattern unterminated string'); } value += source[i++]; } if (source[i] !== quote) throw new SyntaxError('pattern unterminated string'); i++; tokens.push({ type: 'string', value }); continue; }
    const number = /^(?:0x[0-9a-f]+|[0-9]+)/i.exec(source.slice(i));
    if (number) { tokens.push({ type: 'number', value: number[0] }); i += number[0].length; continue; }
    const identifier = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(source.slice(i));
    if (identifier) { tokens.push({ type: 'identifier', value: identifier[0] }); i += identifier[0].length; continue; }
    throw new SyntaxError(`pattern unexpected character: ${char}`);
  }
  tokens.push({ type: 'eof', value: '' });
  return tokens;
}

export function parsePattern(source) {
  if (source && typeof source === 'object') return deepFreeze({ languageVersion: PATTERN_LANGUAGE_VERSION, ast: source, source: stableDigest(source) });
  const raw = text(source).trim();
  if (!raw) throw new SyntaxError('pattern source is empty');
  if (raw.startsWith('{') || raw.startsWith('[')) {
    let ast;
    try { ast = JSON.parse(raw); } catch (error) { throw new SyntaxError(`pattern JSON malformed: ${error.message}`); }
    return deepFreeze({ languageVersion: PATTERN_LANGUAGE_VERSION, ast, source: raw });
  }
  const tokens = tokenize(raw); let cursor = 0;
  const peek = () => tokens[cursor];
  const take = (type, value = null) => { const token = tokens[cursor]; if (token.type !== type || value != null && token.value !== value) throw new SyntaxError(`pattern expected ${value || type}`); cursor++; return token; };
  const parseType = () => {
    const base = take('identifier').value;
    let type = PRIMITIVES.has(base) ? { kind: 'primitive', name: base } : { kind: 'named', name: base };
    if (peek().type === '<') { take('<'); const target = parseType(); take('>'); type = { kind: base === 'ptr' || base === 'pointer' ? 'pointer' : 'offset', space: 'file', target }; }
    if (peek().type === '[') { take('['); const count = peek().type === 'number' ? Number(take('number').value) : take('identifier').value; take(']'); type = { kind: 'array', element: type, count }; }
    return type;
  };
  take('identifier', 'struct'); const name = take('identifier').value; take('{'); const fields = [];
  while (peek().type !== '}') { const fieldName = take('identifier').value; take(':'); const type = parseType(); take(';'); fields.push({ name: fieldName, type }); }
  take('}'); take('eof');
  return deepFreeze({ languageVersion: PATTERN_LANGUAGE_VERSION, ast: { kind: 'struct', name, fields }, source: raw });
}

function fail(code) { const error = new TypeError(code); error.code = code; throw error; }
function validateExpression(expression, depth = 0) {
  if (!expression || typeof expression !== 'object' || Array.isArray(expression) || depth > 32) fail('pattern-expression-invalid');
  const op = expression.op;
  if (!['const', 'ref', 'eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'and', 'or', 'not'].includes(op)) fail('pattern-expression-op-unsupported');
  if (op === 'const') return;
  if (op === 'ref') { if (typeof expression.path !== 'string' || !expression.path) fail('pattern-expression-ref-invalid'); return; }
  if (op === 'not') return validateExpression(expression.arg, depth + 1);
  if (['and', 'or'].includes(op)) { if (!Array.isArray(expression.args) || !expression.args.length) fail('pattern-expression-args-invalid'); expression.args.forEach((item) => validateExpression(item, depth + 1)); return; }
  validateExpression(expression.left, depth + 1); validateExpression(expression.right, depth + 1);
}

function validateType(type, depth = 0, names = new Set()) {
  if (!type || typeof type !== 'object' || depth > 64) fail('pattern-type-invalid');
  if (type.kind === 'primitive') { if (!PRIMITIVES.has(type.name)) fail('pattern-primitive-unsupported'); return; }
  if (type.kind === 'named') { if (!names.has(type.name)) fail(`pattern-type-unknown:${type.name}`); return; }
  if (type.kind === 'struct') { const fields = list(type.fields); if (!fields.length || fields.length > 10_000) fail('pattern-struct-fields-invalid'); for (const field of fields) { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name)) fail('pattern-field-name-invalid'); validateType(field.type, depth + 1, names); if (field.when) validateExpression(field.when); } return; }
  if (type.kind === 'array') {
    if (type.count == null || typeof type.count === 'boolean') fail('pattern-array-count-invalid');
    if (typeof type.count === 'object') validateExpression(type.count);
    if (typeof type.count === 'number' && (!Number.isSafeInteger(type.count) || type.count < 0)) fail('pattern-array-count-invalid');
    if (typeof type.count === 'string' && !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(type.count)) fail('pattern-array-count-ref-invalid');
    validateType(type.element, depth + 1, names); return;
  }
  if (type.kind === 'pointer' || type.kind === 'offset') { if (typeof type.space !== 'string' || !type.space) fail('pattern-address-space-required'); validateType(type.target, depth + 1, names); return; }
  if (type.kind === 'conditional') { validateExpression(type.when); validateType(type.then, depth + 1, names); if (type.else) validateType(type.else, depth + 1, names); return; }
  if (type.kind === 'union') { if (!list(type.options).length) fail('pattern-union-empty'); type.options.forEach((item) => validateType(item, depth + 1, names)); return; }
  if (type.kind === 'enum') { validateType(type.base, depth + 1, names); return; }
  if (type.kind === 'bitfield') { validateType(type.base, depth + 1, names); if (!Array.isArray(type.fields)) fail('pattern-bitfield-fields-invalid'); return; }
  fail(`pattern-type-kind-unsupported:${type.kind}`);
}

export function typeCheckPattern(parsed) {
  const input = parsed?.ast ? parsed : parsePattern(parsed);
  const ast = input.ast;
  const structs = ast.kind === 'module' ? list(ast.structs) : [ast];
  const names = new Set(structs.filter((item) => item.kind === 'struct' && item.name).map((item) => item.name));
  for (const item of structs) { if (item.kind !== 'struct') fail('pattern-root-must-be-struct'); validateType(item, 0, names); }
  if (ast.kind === 'module' && ast.root != null && !names.has(ast.root)) fail('pattern-module-root-unknown');
  return deepFreeze(input);
}

export function compilePattern(source, options = {}) {
  const parsed = typeCheckPattern(parsePattern(source));
  const sourceHash = stableDigest(parsed.ast);
  const compileOptions = { targetAddressSpace: options.targetAddressSpace || 'file', semanticVersion: PATTERN_LANGUAGE_VERSION, options: options.compileOptions || {} };
  return deepFreeze({ languageVersion: PATTERN_LANGUAGE_VERSION, sourceHash, patternId: `pattern:${stableDigest({ sourceHash, compileOptions })}`, ast: parsed.ast, snapshotId: options.snapshotId || null, compileOptions });
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}
function createSource(input, options = {}) {
  const bytes = toBytes(input);
  if (bytes) {
    const snapshotId = options.snapshotId || stableDigest(Array.from(bytes));
    return { snapshotId, size: bytes.byteLength, read(offset, length, space = 'file') { if (space !== 'file') throw new Error('pattern-address-space-unavailable'); const at = Number(offset), n = Number(length); if (!Number.isSafeInteger(at) || !Number.isSafeInteger(n) || at < 0 || n < 0 || at + n > bytes.byteLength) throw new RangeError('pattern-read-out-of-range'); return bytes.slice(at, at + n); } };
  }
  if (input && typeof input.read === 'function') return { snapshotId: String(input.snapshotId || options.snapshotId || ''), size: input.size ?? null, read: (offset, length, space) => input.read(offset, length, { space }) };
  throw new TypeError('pattern ByteSource is required');
}
function safeNumber(value, code = 'pattern-integer-overflow') { const number = Number(value); if (!Number.isSafeInteger(number) || number < 0) fail(code); return number; }
function primitiveValue(raw, name) { return typeof raw === 'bigint' && raw <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(raw) : raw; }
function provenance(ctx, offset, length, space = 'file') { return { patternId: ctx.patternId, snapshotId: ctx.source.snapshotId, space, offset: String(offset), length: String(length) }; }
function fieldValue(type, value, ctx, offset, length, space = 'file', extra = {}) { return { type: type.kind === 'primitive' ? type.name : type.kind, value, provenance: provenance(ctx, offset, length, space), ...extra }; }
function valueAt(values, path) { let current = values; for (const part of String(path || '').split('.').filter(Boolean)) { if (current == null) return undefined; current = current[part]?.value ?? current[part]; } return current; }
function evaluateExpression(expression, values) {
  if (!expression) return true;
  if (expression.op === 'const') return expression.value;
  if (expression.op === 'ref') return valueAt(values, expression.path);
  if (expression.op === 'not') return !evaluateExpression(expression.arg, values);
  if (expression.op === 'and') return expression.args.every((item) => evaluateExpression(item, values));
  if (expression.op === 'or') return expression.args.some((item) => evaluateExpression(item, values));
  const left = evaluateExpression(expression.left, values), right = evaluateExpression(expression.right, values);
  if (expression.op === 'eq') return left === right; if (expression.op === 'ne') return left !== right; if (expression.op === 'lt') return left < right; if (expression.op === 'lte') return left <= right; if (expression.op === 'gt') return left > right; return left >= right;
}

function staticSize(type, ctx, values = {}) {
  if (type.kind === 'primitive') return PRIMITIVES.get(type.name).bytes;
  if (type.kind === 'pointer' || type.kind === 'offset') return 8;
  if (type.kind === 'enum' || type.kind === 'bitfield') return staticSize(type.base, ctx, values);
  if (type.kind === 'array' && Number.isSafeInteger(type.count)) { const item = staticSize(type.element, ctx, values); return item == null ? null : item * type.count; }
  if (type.kind === 'struct') { let total = 0; for (const field of type.fields) { const size = staticSize(field.type, ctx, values); if (size == null) return null; total += size; } return total; }
  if (type.kind === 'conditional') return staticSize(type.then, ctx, values);
  return null;
}

function readType(type, offset, space, ctx, values, depth = 0) {
  if (!ctx.budget.checkDepth(depth) || !ctx.budget.consumeNodes()) return { status: 'partial', reason: ctx.budget.stopped?.reason || 'resource-limit' };
  if (!ctx.budget.checkpoint()) return { status: 'partial', reason: ctx.budget.stopped?.reason || 'cancelled' };
  if (type.kind === 'primitive') {
    const spec = PRIMITIVES.get(type.name); if (!spec) fail('pattern-primitive-unsupported');
    if (!ctx.budget.consumeBytes(spec.bytes)) return { status: 'partial', reason: ctx.budget.stopped.reason };
    const bytes = ctx.source.read(offset, spec.bytes, space); const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const value = primitiveValue(spec.read(view, 0), type.name);
    return fieldValue(type, value, ctx, offset, spec.bytes, space);
  }
  if (type.kind === 'named') {
    const target = ctx.types.get(type.name);
    if (!target) fail(`pattern-type-unknown:${type.name}`);
    return readType(target, offset, space, ctx, values, depth + 1);
  }
  if (type.kind === 'enum') { const result = readType(type.base, offset, space, ctx, values, depth + 1); return result.status ? result : { ...result, type: 'enum', enumName: type.name || null }; }
  if (type.kind === 'bitfield') { const result = readType(type.base, offset, space, ctx, values, depth + 1); return result.status ? result : { ...result, type: 'bitfield', fields: type.fields }; }
  if (type.kind === 'conditional') return evaluateExpression(type.when, values) ? readType(type.then, offset, space, ctx, values, depth + 1) : type.else ? readType(type.else, offset, space, ctx, values, depth + 1) : fieldValue(type, null, ctx, offset, 0, space, { absent: true });
  if (type.kind === 'pointer' || type.kind === 'offset') {
    const pointer = readType({ kind: 'primitive', name: 'u64le' }, offset, space, ctx, values, depth + 1); if (pointer.status) return pointer;
    const address = pointer.value; const targetSpace = type.space;
    const out = fieldValue(type, address, ctx, offset, 8, space, { targetSpace, lazy: true });
    out.dereference = () => readType(type.target, safeNumber(address), targetSpace, ctx, values, depth + 1);
    return out;
  }
  if (type.kind === 'array') {
    const countValue = typeof type.count === 'number' ? type.count : typeof type.count === 'string' ? valueAt(values, type.count) : evaluateExpression(type.count, values);
    const count = safeNumber(countValue, 'pattern-array-count-invalid');
    const out = fieldValue(type, null, ctx, offset, 0, space, { length: count, lazy: true, materialized: [] });
    const elementSize = staticSize(type.element, ctx, values);
    out.expand = (index) => { const i = safeNumber(index, 'pattern-array-index-invalid'); if (i >= count) throw new RangeError('pattern-array-index-out-of-range'); if (out.materialized[i]) return out.materialized[i]; if (!ctx.budget.consumeEntries()) return ctx.budget.partial(); const at = elementSize == null ? offset : offset + BigInt(i * elementSize); const item = readType(type.element, at, space, ctx, values, depth + 1); out.materialized[i] = item; return item; };
    return out;
  }
  if (type.kind === 'union') {
    const options = type.options.map((item) => readType(item, offset, space, ctx, values, depth + 1));
    return fieldValue(type, options[0]?.value ?? null, ctx, offset, staticSize(type.options[0], ctx, values) || 0, space, { alternatives: options });
  }
  if (type.kind === 'struct') {
    const fields = {}; let cursor = BigInt(offset); const localValues = { ...values };
    for (const field of type.fields) {
      if (field.when && !evaluateExpression(field.when, localValues)) { fields[field.name] = fieldValue(field.type, null, ctx, cursor, 0, space, { absent: true }); continue; }
      const relative = field.at == null ? 0 : safeNumber(typeof field.at === 'number' ? field.at : valueAt(localValues, field.at), 'pattern-field-offset-invalid');
      const fieldOffset = cursor + BigInt(relative); const result = readType(field.type, fieldOffset, space, ctx, localValues, depth + 1); fields[field.name] = result; if (result.status) return result; localValues[field.name] = result; const size = staticSize(field.type, ctx, localValues); if (field.at == null && size != null) cursor += BigInt(size);
    }
    const size = cursor - BigInt(offset); return fieldValue(type, fields, ctx, offset, size, space, { fields });
  }
  fail('pattern-type-unsupported');
}

export function evaluatePattern(compiled, byteSource, options = {}) {
  const pattern = compiled?.patternId ? compiled : compilePattern(compiled, options);
  const source = createSource(byteSource, options);
  if (pattern.snapshotId && pattern.snapshotId !== source.snapshotId) throw new Error('pattern-source-snapshot-mismatch');
  const budget = options.budget || createResourceBudget({ maxBytes: options.maxBytes || 4 * 1024 * 1024, maxNodes: options.maxNodes || 50_000, maxEntries: options.maxEntries || 50_000, maxDepth: options.maxDepth || 64, signal: options.signal });
  const structs = pattern.ast.kind === 'module' ? pattern.ast.structs : [pattern.ast];
  const typeMap = new Map(structs.filter((item) => item?.name).map((item) => [item.name, item]));
  const root = pattern.ast.kind === 'module' ? typeMap.get(pattern.ast.root || structs[0]?.name) : pattern.ast;
  const ctx = { patternId: pattern.patternId, source, budget, types: typeMap };
  const initialValues = pattern.ast.constants && typeof pattern.ast.constants === 'object' ? { constants: pattern.ast.constants } : {};
  const result = readType(root, 0n, options.addressSpace || 'file', ctx, initialValues, 0);
  if (result.status === 'partial' || budget.stopped) return { status: 'partial', reason: result.reason || budget.stopped.reason, patternId: pattern.patternId, snapshotId: source.snapshotId, value: null, budget: budget.snapshot() };
  return { status: 'complete', patternId: pattern.patternId, snapshotId: source.snapshotId, value: result, budget: budget.snapshot() };
}

export function evaluatePatternAsync(compiled, byteSource, options = {}) { return Promise.resolve(evaluatePattern(compiled, byteSource, options)); }

export function patternSupportTruth() { return Object.freeze({ parser: 'supported', evaluator: 'bounded', mutation: 'unsupported', network: 'unsupported', arbitraryJavaScript: 'unsupported', authority: 'L2-evidence' }); }
