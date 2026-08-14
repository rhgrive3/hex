import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function executable() {
  if (process.env.GHIDRA_HEADLESS && fs.existsSync(process.env.GHIDRA_HEADLESS)) return process.env.GHIDRA_HEADLESS;
  if (process.env.GHIDRA_HOME) {
    const p = path.join(process.env.GHIDRA_HOME, 'support', process.platform === 'win32' ? 'analyzeHeadless.bat' : 'analyzeHeadless');
    if (fs.existsSync(p)) return p;
  }
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['analyzeHeadless'], { encoding:'utf8' });
  return probe.status === 0 ? probe.stdout.trim().split(/\r?\n/)[0] : null;
}

export function ghidraAvailability() {
  const exe = executable();
  if (!exe) return { available:false, reason:'Ghidra analyzeHeadless unavailable' };
  return { available:true, executable:exe };
}

function parseOutput(text) {
  const functions = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^GHIDRA_FUNCTION\s+(\S+)\s+(.*)$/.exec(line);
    if (m) functions.set(m[1], m[2].replace(/\\n/g, '\n').replace(/\\\\/g, '\\'));
  }
  return functions;
}

export function runGhidra(binary, opts = {}) {
  const a = ghidraAvailability();
  if (!a.available) return { status:'skipped', reason:a.reason };
  if (!binary || !fs.existsSync(binary)) return { status:'skipped', reason:'benchmark binary unavailable' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-ghidra-'));
  try {
    const args = [tmp, 'hex-diff', '-deleteProject', '-import', path.resolve(binary), '-scriptPath', here, '-postScript', 'GhidraDump.java'];
    const r = spawnSync(a.executable, args, { encoding:'utf8', maxBuffer:64*1024*1024, timeout:Number(opts.timeoutMs || 180000) });
    if (r.status !== 0) return { status:'failed', exitCode:r.status, stderr:String(r.stderr || '').slice(-4000) };
    const functions = parseOutput(`${r.stdout || ''}\n${r.stderr || ''}`);
    return { status:'ok', functions:Object.fromEntries(functions), count:functions.size };
  } finally {
    fs.rmSync(tmp, { recursive:true, force:true });
  }
}

export function readabilityMetrics(text) {
  text = String(text || '');
  return {
    gotos:(text.match(/\bgoto\b/g)||[]).length,
    casts:(text.match(/\([^()\n]*(?:int|char|long|short|void|float|double|uint|size_t)[^()\n]*\)/g)||[]).length,
    temporaries:(text.match(/\b(?:local_|uVar|iVar|lVar|pcVar|puVar|tmp|v)\w*/g)||[]).length,
    lines:text ? text.split(/\r?\n/).length : 0,
  };
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const binary = process.argv[2] || null;
  const a = ghidraAvailability();
  if (!binary) {
    console.log('GHIDRA_DIFF ' + JSON.stringify(a.available ? { status:'available', executable:a.executable, policy:'source-ground-truth-not-ghidra' } : { status:'skipped', reason:a.reason }));
    process.exit(0);
  }
  const result = runGhidra(binary);
  console.log('GHIDRA_DIFF ' + JSON.stringify(result));
}
