/**
 * AI 境界の正規化と予算計上の回帰テスト。
 *
 *   #1300  jsonSafe が own __proto__ を落とし、出力の prototype を差し替える
 *   #1301  空/空白 address が 0x0 として通る
 *   #1303  wire budget が表示用 sanitizer の切り詰め後サイズを測る
 *   #1304  worker protocol sanitizer が __proto__ key で prototype を変える
 *   #1337  releaseResident(Infinity) で resident 上限を回避できる
 *
 * 共通するのは「外から来た値が、境界の内側の意味を書き換えてしまう」ことです。
 */
import assert from 'node:assert/strict';
import { jsonSafe, addressText } from '../js/ai/validation.js';
import { sanitizeValue, sanitizeToolSchema } from '../js/ai/provider/worker-protocol.js';
import { measureWirePayload, assertWireBudget } from '../js/ai/budget/wire.js';
import '../js/worker-budget.js';

console.log('Testing AI boundary hardening...');

/* ── #1300 / #1304 入力データが出力の prototype を変えない ──── */

// JSON.parse で作らないと '__proto__' は own key になりません。
const POLLUTED = () => JSON.parse('{"__proto__":{"polluted":true},"safe":1}');

for (const [label, run] of [
  ['jsonSafe', (input) => jsonSafe(input)],
  ['sanitizeValue', (input) => sanitizeValue(input, 0)],
]) {
  const out = run(POLLUTED());
  assert.ok(Object.hasOwn(out, '__proto__'), `${label} must keep own __proto__ as data`);
  assert.equal(out.polluted, undefined, `${label} must not let input set the result prototype`);
  assert.equal(Object.getPrototypeOf(out), Object.prototype, `${label} result must keep Object.prototype`);
  assert.equal(out.safe, 1, `${label} must keep ordinary keys`);
  // グローバルな汚染も起きていないこと。
  assert.equal({}.polluted, undefined, `${label} must not pollute Object.prototype`);
}
console.log('  ok 1 jsonSafe and sanitizeValue keep __proto__ as data (#1300 #1304)');

{
  const schema = sanitizeToolSchema(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"ok":{"type":"number"}}}'));
  assert.ok(Object.hasOwn(schema.properties, '__proto__'), 'a property named __proto__ must survive as data (#1304)');
  assert.equal(Object.getPrototypeOf(schema.properties), Object.prototype, 'the properties map must keep Object.prototype');
  assert.equal(schema.properties.ok.type, 'number', 'ordinary properties must still be sanitized');
}
console.log('  ok 2 tool schema properties cannot rewrite their own prototype (#1304)');

/* ── #1301 空アドレスは address 0 ではない ─────────────────── */

for (const blank of ['', ' ', '\t', '\n', '   \t\n ']) {
  assert.equal(addressText(blank), null, `blank address ${JSON.stringify(blank)} must be rejected, not read as 0x0 (#1301)`);
}
// 明示的な 0 は今までどおり有効。
assert.equal(addressText('0'), '0x0');
assert.equal(addressText(0), '0x0');
assert.equal(addressText(0n), '0x0');
assert.equal(addressText('0x0'), '0x0');
// 通常のアドレスと不正値も従来どおり。
assert.equal(addressText('0x100000000'), '0x100000000');
assert.equal(addressText(-1), null);
assert.equal(addressText('nonsense'), null);
assert.equal(addressText(null), null);
assert.equal(addressText(undefined), null);
console.log('  ok 3 blank addresses are absent input, not address zero (#1301)');

/* ── #1303 予算は実際に送る payload を測る ─────────────────── */

{
  // 1001 件目に大きな description。表示用 sanitizer は 1000 件で切るので、
  // 旧実装ではこの 100KB が計測から完全に消えていました。
  const tools = Array.from({ length: 1001 }, (_, i) => (
    i === 1000 ? { name: 'last', description: 'X'.repeat(100_000) } : { name: `t${i}` }
  ));
  const usage = measureWirePayload({ tools });
  assert.ok(
    usage.toolSchemaBytes > 100_000,
    `tool schema bytes must include everything that is sent, got ${usage.toolSchemaBytes} (#1303)`,
  );
  assert.ok(usage.wireBytes >= usage.toolSchemaBytes, 'the whole payload is at least its tool schemas');

  // そしてその payload は予算を超えるので、拒否されなければなりません。
  assert.throws(
    () => assertWireBudget({ tools }, { maxRequestBytes: 64 * 1024, contextTokens: 32768, maxOutputTokens: 4096 }),
    /exceeds the safe input budget/,
    'an over-budget payload must be refused, not measured small enough to pass (#1303)',
  );
}

{
  // 201 個目以降の key も同じ。
  const context = {};
  for (let i = 0; i < 260; i++) context[`k${i}`] = i === 259 ? 'Y'.repeat(50_000) : i;
  const usage = measureWirePayload({ context });
  assert.ok(usage.semanticContextBytes > 50_000, `context bytes must include keys past the display cap, got ${usage.semanticContextBytes} (#1303)`);
}

{
  // 深いネストも切り詰めない。
  let deep = { leaf: 'Z'.repeat(20_000) };
  for (let i = 0; i < 25; i++) deep = { next: deep };
  const usage = measureWirePayload({ context: deep });
  assert.ok(usage.semanticContextBytes > 20_000, `deep context must be measured in full, got ${usage.semanticContextBytes} (#1303)`);
}

{
  // BigInt を含む payload も測れる（表示用 sanitizer と同じ綴り）。
  const usage = measureWirePayload({ context: { address: 0x100000000n } });
  assert.ok(usage.semanticContextBytes > 0, 'a BigInt payload must remain measurable');
}

{
  // 小さな payload は今までどおり通る。
  const usage = assertWireBudget({ messages: [{ role: 'user', content: 'hi' }] });
  assert.ok(usage.wireBytes > 0 && usage.wireBytes < 1024);
}
console.log('  ok 4 wire budget measures the payload that is actually sent (#1303)');

/* ── #1337 release は take と同じ厳しさで ──────────────────── */

const RESIDENT_LIMIT = 8 * 1024 * 1024;

for (const bad of [Infinity, -Infinity, Number.NaN, 'lots', null, undefined, {}]) {
  const budget = globalThis.HexWorkerBudget.createSupplementalBudget();
  assert.equal(budget.takeResident(RESIDENT_LIMIT), true, 'the ceiling must be reachable');
  assert.equal(budget.takeResident(1), false, 'the ceiling must hold');
  budget.releaseResident(bad);
  assert.equal(
    budget.snapshot().resident,
    RESIDENT_LIMIT,
    `releaseResident(${String(bad)}) must not change accounting (#1337)`,
  );
  assert.equal(budget.takeResident(1), false, `releaseResident(${String(bad)}) must not reopen the ceiling (#1337)`);
}

{
  // 正当な解放は今までどおり効く。
  const budget = globalThis.HexWorkerBudget.createSupplementalBudget();
  assert.equal(budget.takeResident(RESIDENT_LIMIT), true);
  budget.releaseResident(1024);
  assert.equal(budget.snapshot().resident, RESIDENT_LIMIT - 1024);
  assert.equal(budget.takeResident(1024), true, 'a real release must make room again');
  assert.equal(budget.takeResident(1), false, 'and only that much room');
}

{
  // 過剰な解放でも負にはならない。
  const budget = globalThis.HexWorkerBudget.createSupplementalBudget();
  assert.equal(budget.takeResident(1024), true);
  budget.releaseResident(4096);
  assert.equal(budget.snapshot().resident, 0, 'over-release must clamp at zero, not go negative');
}
console.log('  ok 5 resident release rejects non-finite amounts (#1337)');

console.log('AI boundary hardening: PASS');
