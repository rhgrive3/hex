/**
 * #1287 — analyzeFunction の semantic model 行数上限の境界回帰。
 *
 * `MAX_MODEL_ROWS = 6000` は model 構築の作業量を抑えるための宣言された上限
 * ですが、push 前に `<=` で判定していたため配列が 6001 件に達していました。
 *
 * 単に `<` へ直すだけでは足りません。6001 件目は
 * `buildSemanticModel` に「入力が上限を超えた」と気付かせる唯一の合図でも
 * あり、それを消すと 6000 行を超える関数で `truncated` が false になります。
 * つまり「1000 命令を捨てたのに完全だと申告する」状態になります。
 *
 * そこで上限は厳密に 6000 とし、切り捨てが起きた事実は長さから推測せず
 * 明示フラグで伝えます。このテストは両方を固定します。
 */
import assert from 'node:assert/strict';
import { analyzeFunction } from '../js/analyze.js';
import { CHUNK_ROWS } from '../js/backend.js';

console.log('Testing analyzeFunction model row bound...');

const MAX_MODEL_ROWS = 6000;

/**
 * 決定的なスタブ backend。全行 `nop` の連続を返します。
 * `nop` は分岐でも呼び出しでもないので、行数の境界だけを見られます。
 */
function stubBackend(totalRows) {
  return {
    async fetchChunk(_regionId, chunkIndex) {
      const base = chunkIndex * CHUNK_ROWS;
      const mn = [];
      const ops = [];
      for (let i = 0; i < CHUNK_ROWS; i++) {
        const row = base + i;
        mn.push(row < totalRows ? 'nop' : '');
        ops.push('');
      }
      return { mn, ops };
    },
    async readAt() { return { found: false }; },
  };
}

function region(totalRows) {
  return { id: 'r0', vmAddr: 0x100000000n, size: BigInt(totalRows) * 4n };
}

async function analyzeRows(totalRows) {
  const rows = totalRows;
  return analyzeFunction(stubBackend(rows), region(rows), 0, rows - 1, null, null, { texts: false });
}

/* ── ちょうど上限まで: 切り捨てなし ─────────────────────────── */

{
  const res = await analyzeRows(MAX_MODEL_ROWS);
  assert.equal(res.instructions, MAX_MODEL_ROWS, 'every row must still be counted');
  assert.equal(res.model.instructions.length, MAX_MODEL_ROWS, 'exactly the cap must reach the model');
  assert.equal(res.model.truncated, false, 'exactly the cap is not truncation');
  assert.equal(res.truncated, false, 'exactly the cap is not truncation');
  console.log(`  ok ${MAX_MODEL_ROWS} rows -> ${res.model.instructions.length} model rows, truncated=false`);
}

/* ── 上限 +1: 上限は厳密に守り、切り捨ては申告する ──────────── */

{
  const res = await analyzeRows(MAX_MODEL_ROWS + 1);
  assert.equal(res.instructions, MAX_MODEL_ROWS + 1, 'every row must still be counted');
  assert.ok(
    res.model.instructions.length <= MAX_MODEL_ROWS,
    `model rows must never exceed ${MAX_MODEL_ROWS}, got ${res.model.instructions.length} (#1287)`,
  );
  assert.equal(res.model.instructions.length, MAX_MODEL_ROWS, 'the model must be filled up to the cap');
  assert.equal(res.model.truncated, true, 'dropping a row must be reported as truncation, not hidden');
  assert.equal(res.truncated, true, 'the analysis result must inherit the truncation');
  console.log(`  ok ${MAX_MODEL_ROWS + 1} rows -> ${res.model.instructions.length} model rows, truncated=true`);
}

/* ── 大きく超えても同じ ─────────────────────────────────────── */

{
  const res = await analyzeRows(MAX_MODEL_ROWS + 1000);
  assert.equal(res.model.instructions.length, MAX_MODEL_ROWS, 'the cap holds well past the boundary');
  assert.equal(res.model.truncated, true, 'a large overflow is still reported');
  assert.equal(res.truncated, true);
  console.log(`  ok ${MAX_MODEL_ROWS + 1000} rows -> ${res.model.instructions.length} model rows, truncated=true`);
}

/* ── 小さい関数は影響を受けない ─────────────────────────────── */

{
  const res = await analyzeRows(16);
  assert.equal(res.model.instructions.length, 16);
  assert.equal(res.model.truncated, false);
  assert.equal(res.truncated, false);
  console.log('  ok small functions are unaffected');
}

console.log('analyzeFunction model row bound: PASS');
