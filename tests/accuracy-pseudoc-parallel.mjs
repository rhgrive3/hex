import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pseudocSamples } from './accuracy-pseudoc-shard-oracle.mjs';
import { pseudocResult } from './accuracy-pseudoc-eval.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const target = opt('target', null);
const oraclePath = opt('oracle', null);
const workers = Math.max(1, Math.min(4, Number(opt('workers', '4')) || 4));
const json = argv.includes('--json');
if (!target || !oraclePath) {
  console.error('usage: node tests/accuracy-pseudoc-parallel.mjs --target=<binary> --oracle=<oracle.json.gz> [--workers=4] [--json]');
  process.exit(2);
}

const oracle = JSON.parse(zlib.gunzipSync(fs.readFileSync(oraclePath)).toString('utf8'));
if (!Array.isArray(oracle.functionStarts)) throw new Error('oracle.functionStarts is required');
const samples = pseudocSamples(oracle.functionStarts);
if (samples.length !== 120) throw new Error(`expected the canonical 120 pseudoc samples, got ${samples.length}`);

let next = 0;
let finished = 0;
let lines = 0;
let asmLines = 0;
let done = 0;
let failed = null;
const seen = new Set();
const timings = [];
const children = new Set();
const started = Date.now();

function assign(child, onError) {
  if (failed || next >= samples.length) return false;
  const index = next++;
  const [a, end] = samples[index];
  try {
    child.send({ type: 'task', index, a, end }, (error) => {
      if (error && !failed && finished < samples.length) onError(error);
    });
  } catch (error) {
    onError(error);
    return false;
  }
  return true;
}

function disconnectChild(child) {
  if (!child.connected) return;
  try { child.disconnect(); } catch { /* channel may close between check and disconnect */ }
}

function disconnectAll() {
  for (const child of children) disconnectChild(child);
}

function shutdown() {
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch { /* best effort */ }
  }
}

const completion = new Promise((resolve, reject) => {
  const fail = (error) => {
    if (failed) return;
    failed = error instanceof Error ? error : new Error(String(error));
    shutdown();
    reject(failed);
  };

  for (let worker = 0; worker < workers; worker++) {
    const child = fork(path.join(HERE, 'accuracy-pseudoc-worker.mjs'), [target], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: ['--max-old-space-size=2600'],
    });
    children.add(child);
    child.stderr.on('data', (chunk) => process.stderr.write(`[pseudoc worker ${worker}] ${chunk}`));

    child.on('error', (error) => {
      if (!failed && finished < samples.length) fail(error);
    });

    child.on('message', (message) => {
      if (!message || failed) return;
      if (message.type === 'ready') {
        process.stderr.write(`pseudoc worker ${worker} ready in ${message.bootMs}ms\n`);
        assign(child, fail);
        return;
      }
      if (message.type === 'fatal') {
        fail(new Error(`pseudoc worker ${worker} failed sample ${message.index}: ${message.message}`));
        return;
      }
      if (message.type !== 'result') return;
      if (seen.has(message.index)) {
        fail(new Error(`duplicate pseudoc result for sample ${message.index}`));
        return;
      }
      seen.add(message.index);
      lines += Number(message.lines) || 0;
      asmLines += Number(message.asmLines) || 0;
      done += Number(message.done) || 0;
      finished++;
      timings.push({
        index: message.index,
        addr: `0x${Number(message.a).toString(16)}`,
        bytes: Number(message.end) - Number(message.a),
        elapsedMs: Number(message.elapsedMs) || 0,
        analyzeMs: Number(message.analyzeMs) || 0,
        decompileMs: Number(message.decompileMs) || 0,
      });

      if (finished === samples.length) {
        // Workers that run out of queued tasks remain idle but connected until
        // the last in-flight function completes. Disconnect once, here, rather
        // than sending repeated stop messages to channels that may already be
        // closing (the old scheme caused ERR_IPC_CHANNEL_CLOSED on YWP).
        disconnectAll();
        resolve();
      } else {
        assign(child, fail);
      }
    });

    child.on('exit', (code, signal) => {
      children.delete(child);
      if (!failed && finished < samples.length) {
        fail(new Error(`pseudoc worker ${worker} exited early (${code ?? signal ?? 'unknown'})`));
      }
    });
  }
});

try {
  await completion;
} catch (error) {
  console.error(error?.stack || error);
  process.exit(1);
}

if (seen.size !== samples.length) throw new Error(`pseudoc coverage mismatch: ${seen.size}/${samples.length}`);
const elapsed = Date.now() - started;
const slowest = timings.slice().sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 8);
for (const timing of slowest) {
  process.stderr.write(
    `pseudoc sample ${timing.index} ${timing.addr} ${timing.bytes}B: ${timing.elapsedMs}ms ` +
    `(analyze=${timing.analyzeMs}ms decompile=${timing.decompileMs}ms)\n`,
  );
}

const result = {
  id: 'pseudoc',
  label: '逆コンパイルで訳せない命令が残らない',
  ...pseudocResult(lines, asmLines, done, elapsed),
};
if (json) console.log(JSON.stringify([result], null, 2));
else console.log(`${(result.score * 100).toFixed(1)}%  ${result.label}  ${result.detail}`);
