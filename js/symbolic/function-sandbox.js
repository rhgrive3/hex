/*
 * symbolic/function-sandbox.js — deterministic concrete function sandbox.
 * Existing Emulator remains the execution engine; this layer supplies function-
 * level setup, fake object/stack memory and evidence-friendly result snapshots.
 */
import { Emulator } from '../emu.js';
import { symbolicExecute } from './executor.js';

export const DEFAULT_OBJECT_BASE = 0x0000600000001000n;

function asBig(v) { return typeof v === 'bigint' ? v : BigInt(v || 0); }

function normalizeWatch(watch, objectBase) {
  const out = [];
  const list = Array.isArray(watch) ? watch : [];
  for (const w of list) {
    if (!w) continue;
    const size = Math.max(1, Number(w.size || 8));
    const addr = w.address != null ? asBig(w.address) : objectBase + asBig(w.offset || 0);
    out.push({ name: w.name || null, address: addr, offset: addr - objectBase, size });
  }
  return out;
}

function watchesFromOptions(o, objectBase) {
  if (Array.isArray(o.watch)) return normalizeWatch(o.watch, objectBase);
  if (Array.isArray(o.objectMemory)) return normalizeWatch(o.objectMemory, objectBase);
  if (o.objectMemory && typeof o.objectMemory === 'object') {
    return Object.keys(o.objectMemory).map((offset) => ({
      name: null,
      address: objectBase + BigInt(offset),
      offset: BigInt(offset),
      size: 8,
    }));
  }
  return [];
}

async function snapshot(emu, watch) {
  const out = [];
  for (const w of watch) out.push({ ...w, value: await emu.load(w.address, w.size) });
  return out;
}

function sparseObjectBytes(emu, objectBase, maxObjectSize) {
  const bytes = new Map();
  const hi = objectBase + BigInt(maxObjectSize);
  for (const [key, page] of emu.mem || []) {
    const base = BigInt(key);
    for (let i = 0; i < page.mask.length; i++) {
      if (!page.mask[i]) continue;
      const addr = base + BigInt(i);
      if (addr < objectBase || addr >= hi) continue;
      bytes.set(addr.toString(), emu.byteAt(addr));
    }
  }
  return bytes;
}

function modifiedRanges(emu, objectBase, maxObjectSize, beforeBytes) {
  const afterBytes = sparseObjectBytes(emu, objectBase, maxObjectSize);
  const addresses = new Set([...beforeBytes.keys(), ...afterBytes.keys()]);
  const changed = [];
  for (const key of addresses) {
    const beforeHas = beforeBytes.has(key), afterHas = afterBytes.has(key);
    if (beforeHas && afterHas && beforeBytes.get(key) === afterBytes.get(key)) continue;
    if (!afterHas) continue;
    changed.push(BigInt(key));
  }
  changed.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const ranges = [];
  for (const addr of changed) {
    const last = ranges[ranges.length - 1];
    if (last && last.address + BigInt(last.size) === addr) last.size++;
    else ranges.push({ address: addr, offset: addr - objectBase, size: 1 });
  }
  return ranges;
}

function branchTrace(trace) {
  const out = [];
  for (let i = 0; i < (trace || []).length - 1; i++) {
    const cur = trace[i], next = trace[i + 1];
    if (!cur || !/^((b\.[a-z]+)|cbz|cbnz|tbz|tbnz)\b/i.test(cur.text || '')) continue;
    out.push({
      address: cur.addr,
      text: cur.text,
      next: next.addr,
      taken: next.addr !== cur.addr + 4n,
    });
  }
  return out;
}

export class FunctionSandbox {
  constructor(io, opts) {
    this.emulator = new Emulator(io || {});
    this.objectBase = opts && opts.objectBase != null ? asBig(opts.objectBase) : DEFAULT_OBJECT_BASE;
    this.maxObjectSize = Math.max(0x100, Number(opts && opts.maxObjectSize || 0x10000));
    this.watch = [];
    this.before = [];
    this.beforeObjectBytes = new Map();
  }

  async setup(address, opts) {
    const o = opts || {};
    const args = (o.args || []).map(asBig);
    const objectBase = o.objectBase != null ? asBig(o.objectBase) : this.objectBase;
    this.objectBase = objectBase;
    if (o.objectAsArg0 !== false && args.length === 0) args.push(objectBase);
    else if (o.objectAsArg0 !== false && args[0] == null) args[0] = objectBase;
    this.emulator.reset();
    // Runtime adapters may select a disjoint synthetic heap. Make this an
    // explicit setup input instead of relying on mutation surviving reset().
    // Repeated setup calls with the same heapBase deterministically reset the
    // allocator to the same start address.
    if (o.heapBase != null) this.emulator.heap = asBig(o.heapBase);
    this.emulator.setup(asBig(address), args);

    for (const [reg, value] of Object.entries(o.registers || {})) this.emulator.set(reg, asBig(value));

    if (Array.isArray(o.objectMemory)) {
      for (const item of o.objectMemory) {
        if (!item) continue;
        await this.emulator.store(objectBase + asBig(item.offset || 0), Number(item.size || 8), asBig(item.value));
      }
    } else if (o.objectMemory && typeof o.objectMemory === 'object') {
      for (const [offset, value] of Object.entries(o.objectMemory)) {
        await this.emulator.store(objectBase + BigInt(offset), 8, asBig(value));
      }
    }

    for (const item of o.stackMemory || []) {
      if (!item) continue;
      await this.emulator.store(this.emulator.sp + asBig(item.offset || 0), Number(item.size || 8), asBig(item.value));
    }
    for (const bp of o.breakpoints || []) this.emulator.breakpoints.add(asBig(bp).toString());

    this.watch = watchesFromOptions(o, objectBase);
    this.before = await snapshot(this.emulator, this.watch);
    // Setup writes establish the sandbox's initial state. They must not later be
    // reported as function effects.
    this.beforeObjectBytes = sparseObjectBytes(this.emulator, objectBase, this.maxObjectSize);
    return this.state();
  }

  state() {
    return {
      pc: this.emulator.pc,
      sp: this.emulator.sp,
      registers: Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['x' + i, this.emulator.get('x' + i)])),
      stopped: this.emulator.stopped,
      steps: this.emulator.steps,
    };
  }

  setRegister(reg, value) { this.emulator.set(reg, asBig(value)); }
  getRegister(reg) { return this.emulator.get(reg); }
  addBreakpoint(address) { this.emulator.breakpoints.add(asBig(address).toString()); }
  removeBreakpoint(address) { this.emulator.breakpoints.delete(asBig(address).toString()); }

  async step() { return this.emulator.step(); }

  async run(opts) {
    const o = opts || {};
    const maxSteps = Math.max(1, Number(o.maxSteps || 20000));
    const result = await this.emulator.run(maxSteps, o.onProgress);
    const after = await snapshot(this.emulator, this.watch);
    const beforeBy = new Map(this.before.map((x) => [x.address.toString() + ':' + x.size, x]));
    const touchedFields = [];
    for (const a of after) {
      const b = beforeBy.get(a.address.toString() + ':' + a.size);
      if (!b || b.value !== a.value) touchedFields.push({
        name: a.name, address: a.address, offset: a.offset, size: a.size,
        before: b ? b.value : null, after: a.value,
      });
    }
    return {
      ...result,
      stopped: this.emulator.stopped,
      returnValue: this.emulator.get('x0'),
      before: this.before,
      after,
      touchedFields,
      modifiedObjectRanges: modifiedRanges(this.emulator, this.objectBase, this.maxObjectSize, this.beforeObjectBytes),
      takenBranches: branchTrace(this.emulator.trace),
      trace: (this.emulator.trace || []).slice(),
      log: (this.emulator.log || []).slice(),
      steps: this.emulator.steps,
      engine: 'function-sandbox',
    };
  }

  symbolic(ir, opts) { return symbolicExecute(ir, opts); }
}

export function createFunctionSandbox(io, opts) { return new FunctionSandbox(io, opts); }
