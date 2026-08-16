import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSemanticModel } from '../../js/blocks.js';
import {
  buildIR,
  getLastSemanticV2Instrumentation,
  setSemanticMigrationMode,
} from '../../js/ir.js';
import { SEMANTIC_V2_MIGRATION_MODES } from '../../js/semantics/compat/index.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const proofPath = ['machine-effects','semantic-ir-v2','scalar-ssa','region-resolver','memoryssa','v1-compat'];

// Prove the public facade itself is selecting the explicit v2 route before the
// unchanged current corpus is launched in isolated child processes.
const BASE = 0x100000000n;
const rows = ['mov x20, x19', 'ldr w8, [x20, #0x20]', 'ret'].map((line, row) => {
  const split = line.indexOf(' ');
  return {
    row,
    address: BASE + BigInt(row * 4),
    mn: split < 0 ? line : line.slice(0, split),
    ops: split < 0 ? '' : line.slice(split + 1),
  };
});
const rowOfAddress = (address) => {
  const delta = address - BASE;
  return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
};
const proofModel = buildSemanticModel(rows, { startRow:0, endRow:rows.length - 1, rowOfAddress });
setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);
const proofIr = buildIR(proofModel, { rowOfAddress });
assert.ok(proofIr, 'explicit v2 public facade must produce a v1 compatibility result');
const proof = getLastSemanticV2Instrumentation();
assert.equal(proof?.v2Executed, true, 'public facade must expose proof that v2 executed');
assert.deepEqual(proof?.path, proofPath);
setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);

function commandsFor(scriptName) {
  const script = packageJson.scripts?.[scriptName];
  if (typeof script !== 'string' || !script.trim()) throw new Error(`missing npm script: ${scriptName}`);
  return script.split(/\s*&&\s*/).map((command) => command.trim()).filter(Boolean);
}

const cacheKey = String(process.env.GITHUB_SHA ?? `pid-${process.pid}`).replace(/[^A-Za-z0-9_.-]/g, '_');
const cacheFile = path.join(os.tmpdir(), `hex-phase3-current-corpus-${cacheKey}.json`);
let report = null;
if (process.env.GITHUB_SHA && fs.existsSync(cacheFile)) {
  try { report = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { report = null; }
}

if (!report) {
  const preloadFile = path.join(os.tmpdir(), `hex-phase3-v2-preload-${process.pid}.mjs`);
  const irUrl = pathToFileURL(path.join(root, 'js/ir.js')).href;
  fs.writeFileSync(preloadFile,
    `import { setSemanticMigrationMode } from ${JSON.stringify(irUrl)};\n` +
    `setSemanticMigrationMode('semantic-v2-compat');\n`);
  const preloadUrl = pathToFileURL(preloadFile).href;
  const inheritedNodeOptions = String(process.env.NODE_OPTIONS ?? '').trim();
  const env = {
    ...process.env,
    NODE_OPTIONS: [inheritedNodeOptions, `--import=${preloadUrl}`].filter(Boolean).join(' '),
  };

  const runCommand = (suite, index, command) => {
    const child = spawnSync('bash', ['-lc', command], {
      cwd: root,
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 180_000,
    });
    process.stdout.write(`\n[phase3-v2-${suite} ${index + 1}] ${command}\n`);
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    return {
      command,
      status: child.status,
      signal: child.signal ?? null,
      timedOut: child.error?.code === 'ETIMEDOUT',
      passed: child.status === 0,
    };
  };

  const semanticResults = commandsFor('semantic:test').map((command, index) => runCommand('semantic', index, command));
  const decompilerResults = commandsFor('decompiler:test').map((command, index) => runCommand('decompiler', index, command));
  const summarize = (results) => ({
    total: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    results,
  });
  report = {
    migrationMode: SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT,
    path: proofPath,
    semantic: summarize(semanticResults),
    decompiler: summarize(decompilerResults),
  };
  fs.writeFileSync(cacheFile, JSON.stringify(report, null, 2));
  fs.rmSync(preloadFile, { force:true });
}

globalThis.__HEX_PHASE3_CURRENT_CORPUS__ = report;
console.log('[phase3-current-corpus]', JSON.stringify({
  semantic: { total:report.semantic.total, passed:report.semantic.passed, failed:report.semantic.failed },
  decompiler: { total:report.decompiler.total, passed:report.decompiler.passed, failed:report.decompiler.failed },
}));
