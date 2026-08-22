/**
 * 明示的な falsy AbortSignal.reason を保存する回帰テスト。
 *
 *   #1284  Backend Mach-O 解析
 *   #1323  RuntimeAnalysisPlatform
 *   #1326  WorkerAIProvider
 *   #1345  AI transport
 *
 * `AbortController.abort(reason)` の reason は任意の値を取れます。`false` /
 * `0` / `''` は「reason が無い」ではなく「明示的にその値を指定した」です。
 * `reason || 'cancelled'` はそれを潰してしまい、caller が付けた識別が
 * 消えます。正しい fallback は `??` です。
 *
 * このファイルは 2 段構えです。
 *
 *  1. 実際に動かせる経路は挙動で確かめる。
 *  2. reason を別の controller へ渡す／throw する全ての箇所を source 上で
 *     走査し、`||` に戻っていないことを機械的に固定する。
 *     欠陥は 4 件の issue に書かれた 8 箇所だけでなく、同じ形が
 *     repository 全体に 15 箇所ありました。1 箇所ずつ直しても、次に
 *     書かれる 16 箇所目は止められません。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestJSON } from '../js/ai/transport.js';

console.log('Testing abort reason preservation...');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 明示 reason として扱わなければならない値。どれも falsy です。 */
const EXPLICIT_FALSY = [false, 0, '', Number.NaN];

/* ── 1. 挙動: AI transport (#1345) ──────────────────────────── */

for (const reason of EXPLICIT_FALSY) {
  const external = new AbortController();
  let inner = Symbol('not-observed');
  try {
    await requestJSON('/x', {}, {
      signal: external.signal,
      fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          inner = options.signal.reason;
          reject(new Error('aborted'));
        }, { once: true });
        external.abort(reason);
      }),
    });
  } catch { /* the rejection itself is not what this asserts */ }
  assert.ok(
    Object.is(inner, reason),
    `requestJSON must forward abort(${String(reason)}) unchanged, got ${String(inner)} (#1345)`,
  );
}

// reason を渡さない abort も「reason が無い」わけではありません。
// 実装が既定の AbortError を作るので、それも caller の reason として
// そのまま渡さなければなりません。'cancelled' に差し替えてはいけません。
{
  const external = new AbortController();
  let inner = Symbol('not-observed');
  try {
    await requestJSON('/x', {}, {
      signal: external.signal,
      fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => { inner = options.signal.reason; reject(new Error('aborted')); }, { once: true });
        external.abort();
      }),
    });
  } catch { /* see above */ }
  assert.equal(inner?.name, 'AbortError', 'the default abort reason must be forwarded, not replaced');
  assert.equal(Object.is(inner, external.signal.reason), true, 'the forwarded reason must be the same object');
}

// truthy reason は今までどおり。
{
  const external = new AbortController();
  let inner = Symbol('not-observed');
  try {
    await requestJSON('/x', {}, {
      signal: external.signal,
      fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => { inner = options.signal.reason; reject(new Error('aborted')); }, { once: true });
        external.abort('user-stopped');
      }),
    });
  } catch { /* see above */ }
  assert.equal(inner, 'user-stopped', 'a truthy reason must keep working');
}
console.log('  ok 1 AI transport forwards explicit falsy reasons (#1345)');

/* ── 2. source 走査: 伝播サイトは全て ?? であること ─────────── */

/**
 * reason を別の controller へ渡す／throw する行を集める。
 *
 * `String(reason || 'x')` のような表示文字列の組み立ては対象外です。
 * そちらは identity ではなく人間向けの文なので、この不変条件が守るのは
 * 「reason そのものを次へ渡す」箇所に限ります。
 */
const PROPAGATION = /(?:controller\.abort\(|throw\s+)[^;\n]*\breason\b[^;\n]*/g;

function jsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) jsFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const offenders = [];
let propagationSites = 0;
for (const file of jsFiles(path.join(ROOT, 'js'))) {
  const source = fs.readFileSync(file, 'utf8');
  const lines = source.split('\n');
  lines.forEach((line, index) => {
    for (const match of line.matchAll(PROPAGATION)) {
      const text = match[0];
      // 表示用の文字列化はこの不変条件の対象外。
      if (/String\s*\(/.test(text)) continue;
      if (!/\breason\b/.test(text)) continue;
      propagationSites += 1;
      // reason を左辺に置いた truthy fallback だけが違反。
      if (/\breason\s*(?:\?\.[A-Za-z_$][\w$]*\s*)?\|\|/.test(text)) {
        offenders.push(`${path.relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
      }
    }
  });
}

assert.ok(propagationSites >= 15, `the scan must still find the propagation sites, found ${propagationSites}`);
assert.deepEqual(
  offenders,
  [],
  `abort reason must be forwarded with ?? , never || :\n${offenders.join('\n')}`,
);
console.log(`  ok 2 all ${propagationSites} abort-reason propagation sites use nullish fallback (#1284 #1323 #1326 #1345)`);

console.log('abort reason preservation: PASS');
