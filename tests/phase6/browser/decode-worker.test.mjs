import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Exercise the *production* classic decode worker, not a Node-only shortcut.
 *
 * js/platform/capstone-disasm-worker.js is the script the browser actually
 * loads. It is a classic worker: it uses `importScripts` and a shared global
 * scope. Running it here inside a VM context with those primitives emulated
 * proves that the RISC-V wiring works on the same code path the browser runs,
 * against the same deployed capstone.wasm, rather than only proving that a
 * separate Node helper can decode RISC-V.
 */
function runClassicWorker() {
  const scope = {};
  const context = vm.createContext(scope);
  const temporaryModules = [];

  scope.globalThis = scope;
  scope.self = scope;
  scope.console = console;
  scope.URL = URL;
  scope.TextDecoder = TextDecoder;
  scope.TextEncoder = TextEncoder;
  scope.Uint8Array = Uint8Array;
  scope.ArrayBuffer = ArrayBuffer;
  scope.BigInt = BigInt;
  scope.Error = Error;
  scope.WebAssembly = WebAssembly;
  scope.fetch = undefined;
  scope.location = { href: `file://${ROOT}/js/platform/` };
  scope.performance = performance;
  scope.setTimeout = setTimeout;
  scope.clearTimeout = clearTimeout;
  scope.queueMicrotask = queueMicrotask;
  scope.process = process;
  scope.require = undefined;

  scope.importScripts = (...specifiers) => {
    for (const specifier of specifiers) {
      const resolved = path.resolve(ROOT, 'js/platform', specifier);
      let source = fs.readFileSync(resolved, 'utf8');
      if (resolved.endsWith('capstone.js')) {
        // The Emscripten bundle is a CommonJS module; give it the module
        // plumbing it expects and publish its factory on the worker scope,
        // exactly as importScripts would in a browser.
        const modulePath = path.join(os.tmpdir(), `hex-p6-worker-capstone-${process.pid}-${Math.random().toString(36).slice(2)}.cjs`);
        fs.copyFileSync(resolved, modulePath);
        temporaryModules.push(modulePath);
        scope.MCapstone = require(modulePath);
        continue;
      }
      vm.runInContext(source, context, { filename: resolved });
      source = null;
    }
  };

  const workerSource = fs.readFileSync(path.join(ROOT, 'js/platform/capstone-disasm-worker.js'), 'utf8');
  vm.runInContext(workerSource, context, { filename: 'capstone-disasm-worker.js' });
  return { scope, cleanup: () => { for (const file of temporaryModules) { try { fs.rmSync(file, { force: true }); } catch { /* best effort */ } } } };
}

async function decodeThroughWorker(scope, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker did not respond')), 30_000);
    scope.postMessage = (payload) => { clearTimeout(timer); resolve(payload); };
    Promise.resolve(scope.onmessage({ data: message })).catch((error) => { clearTimeout(timer); reject(error); });
  });
}

const require = (await import('node:module')).createRequire(import.meta.url);

test('the production classic decode worker decodes RISC-V64 through the deployed WASM', async () => {
  const { scope, cleanup } = runClassicWorker();
  try {
    // c.li a0,7 | addi a1,a1,1 | c.add a0,a1 | ld a2,0(a0) | ret
    const bytes = new Uint8Array([
      0x1d, 0x45,
      0x93, 0x85, 0x15, 0x00,
      0x2e, 0x95,
      0x03, 0x36, 0x05, 0x00,
      0x67, 0x80, 0x00, 0x00,
    ]);
    // The real Backend sends the address as a BigInt across the structured
    // clone boundary, because Capstone's cs_disasm takes an i64.
    const response = await decodeThroughWorker(scope, { id: 1, architecture: 'riscv64', address: 0x1000n, bytes });
    assert.equal(response.ok, true, `worker failed: ${response.error}`);
    assert.equal(response.bytesConsumed, bytes.length, 'the whole mixed-width stream must decode');
    // The worker's arrays are created inside the worker realm, so copy them
    // out before structural comparison.
    const instructions = Array.from(response.instructions);
    assert.deepEqual(instructions.map((instruction) => Number(instruction.size)), [2, 4, 2, 4, 4]);
    assert.deepEqual(instructions.map((instruction) => Number(instruction.address)), [0x1000, 0x1002, 0x1006, 0x1008, 0x100c]);
    for (const instruction of instructions) {
      assert.equal(instruction.architecture, 'riscv64');
      assert.equal(instruction.mode, 'rv64imc');
      assert.equal(Number(instruction.rawBytes.length), Number(instruction.size));
      assert.ok(instruction.capstoneOperands.length >= 0, 'structured detail must survive the worker boundary');
    }
  } finally { cleanup(); }
});

test('the same worker still decodes ARM64 and x86-64 unchanged', async () => {
  const { scope, cleanup } = runClassicWorker();
  try {
    const arm64 = await decodeThroughWorker(scope, {
      id: 2, architecture: 'arm64', address: 0x1000n,
      bytes: new Uint8Array([0x00, 0x00, 0x80, 0xd2]), // mov x0, #0
    });
    assert.equal(arm64.ok, true, `arm64 regressed: ${arm64.error}`);
    assert.equal(Number(arm64.instructions.length), 1);
    assert.equal(Number(arm64.instructions[0].size), 4);

    const x86 = await decodeThroughWorker(scope, {
      id: 3, architecture: 'x86_64', address: 0x2000n,
      bytes: new Uint8Array([0x48, 0x89, 0xf8, 0xc3]), // mov rax, rdi ; ret
    });
    assert.equal(x86.ok, true, `x86_64 regressed: ${x86.error}`);
    assert.equal(Number(x86.instructions.length), 2);
    assert.equal(x86.instructions[0].architecture, 'x86_64');
  } finally { cleanup(); }
});

test('an unsupported architecture is refused rather than silently decoded as something else', async () => {
  const { scope, cleanup } = runClassicWorker();
  try {
    const response = await decodeThroughWorker(scope, {
      id: 4, architecture: 'riscv32', address: 0x1000n, bytes: new Uint8Array([0x13, 0x00, 0x00, 0x00]),
    });
    assert.equal(response.ok, false);
    assert.match(String(response.error), /Unsupported architecture: riscv32/);
  } finally { cleanup(); }
});

test('the production probe worker reports RISC-V support from the deployed bundle, not from a constant', async () => {
  const scope = {};
  const context = vm.createContext(scope);
  const temporaryModules = [];
  Object.assign(scope, {
    globalThis: scope, self: scope, console, URL, WebAssembly, process,
    setTimeout, clearTimeout, queueMicrotask, performance,
    location: { href: `file://${ROOT}/js/platform/` },
  });
  scope.importScripts = (specifier) => {
    const resolved = path.resolve(ROOT, 'js/platform', specifier);
    const modulePath = path.join(os.tmpdir(), `hex-p6-probe-capstone-${process.pid}-${Math.random().toString(36).slice(2)}.cjs`);
    fs.copyFileSync(resolved, modulePath);
    temporaryModules.push(modulePath);
    scope.MCapstone = require(modulePath);
  };
  try {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'js/platform/capstone-probe-worker.js'), 'utf8'), context, { filename: 'capstone-probe-worker.js' });
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('probe worker did not respond')), 30_000);
      scope.postMessage = (payload) => { clearTimeout(timer); resolve(payload); };
      Promise.resolve(scope.onmessage({ data: {} })).catch((error) => { clearTimeout(timer); reject(error); });
    });
    assert.equal(response.ok, true, `probe failed: ${response.error}`);
    assert.equal(response.support.riscv64, true, 'the deployed bundle must really open RV64');
    assert.equal(response.support.arm64, true);
    assert.equal(response.support.x86_64, true);
  } finally {
    for (const file of temporaryModules) { try { fs.rmSync(file, { force: true }); } catch { /* best effort */ } }
  }
});
