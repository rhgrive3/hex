/*
 * Control-flow-aware provenance for ARM64 ADR/ADRP address construction.
 *
 * Classic-script shape on purpose: worker-legacy.js is a classic worker, while
 * Node regression tests load this file through vm just like words.js.
 */
(function (global) {
  'use strict';

  const DEFAULT_WINDOW = 4096;
  const CALLER_SAVED_LAST = 18;
  const LINK_REGISTER = 30;

  function asBigInt(value) {
    if (value == null) return null;
    try { return BigInt(value); } catch { return null; }
  }

  function create(options) {
    const opts = options || {};
    const window = Number.isFinite(Number(opts.pairWindow))
      ? Math.max(0, Math.floor(Number(opts.pairWindow)))
      : DEFAULT_WINDOW;
    const words = opts.words || global.Words;
    if (!words || !words.KIND) throw new Error('AddressProvenance requires Words');

    const pageOf = new Array(32).fill(null);
    const pageAt = new Int32Array(32);
    pageAt.fill(-1);
    const functionStarts = Array.from(opts.functionStarts || [], asBigInt)
      .filter((start) => start != null)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const startCount = functionStarts.length;
    let startIndex = 0;
    const branchEntries = new Set();
    const rangeStart = asBigInt(opts.rangeStart);
    const rangeEnd = asBigInt(opts.rangeEnd);
    let generation = 0;

    function clear() {
      pageOf.fill(null);
      pageAt.fill(-1);
      generation++;
    }

    function kill(reg) {
      const r = Number(reg);
      if (!Number.isInteger(r) || r < 0 || r >= 32) return;
      pageOf[r] = null;
      pageAt[r] = -1;
    }

    function note(reg, value, index) {
      const r = Number(reg), at = Number(index);
      if (!Number.isInteger(r) || r < 0 || r >= 32 || !Number.isInteger(at)) return;
      const v = asBigInt(value);
      if (v == null) { kill(r); return; }
      pageOf[r] = v;
      pageAt[r] = at;
    }

    function base(reg, index) {
      const r = Number(reg), at = Number(index);
      if (!Number.isInteger(r) || r < 0 || r >= 32 || !Number.isInteger(at)) return null;
      const born = pageAt[r];
      if (born < 0 || at < born || at - born > window) return null;
      return pageOf[r];
    }

    function inRange(target) {
      if (target == null) return false;
      if (rangeStart != null && target < rangeStart) return false;
      if (rangeEnd != null && target >= rangeEnd) return false;
      return true;
    }

    function markForwardEntry(target, pc) {
      if (target == null || target <= pc + 4n || !inRange(target)) return;
      branchEntries.add(target);
    }

    function enter(pcValue) {
      const pc = asBigInt(pcValue);
      if (pc == null) return false;
      let boundary = false;
      while (startIndex < startCount) {
        const start = functionStarts[startIndex];
        if (start < pc) { startIndex++; continue; }
        if (start === pc) { boundary = true; startIndex++; }
        break;
      }
      if (branchEntries.delete(pc)) boundary = true;
      if (boundary) clear();
      return boundary;
    }

    function killCallClobbered() {
      // AAPCS64 caller-clobbered argument/temporary registers are x0-x18.
      // BL/BLR additionally overwrite x30 architecturally with the return
      // address, so stale address provenance must never survive in LR.
      for (let reg = 0; reg <= CALLER_SAVED_LAST; reg++) kill(reg);
      kill(LINK_REGISTER);
    }

    function control(word, pcValue, kind) {
      const pc = asBigInt(pcValue);
      if (pc == null) { clear(); return { barrier: true, target: null }; }
      const K = words.KIND;
      if (kind === K.CALL || kind === K.INDCALL) {
        killCallClobbered();
        return { barrier: false, call: true, target: kind === K.CALL ? words.branchImm26(word, pc) : null };
      }
      if (kind === K.CONDBR) {
        const target = words.condBranchTarget(word, pc);
        markForwardEntry(target, pc);
        return { barrier: false, conditional: true, target };
      }
      if (kind === K.BRANCH) {
        const target = words.branchImm26(word, pc);
        markForwardEntry(target, pc);
        clear();
        return { barrier: true, target };
      }
      if (kind === K.RET || kind === K.TRAP) {
        clear();
        return { barrier: true, target: null };
      }
      return { barrier: false, target: null };
    }

    return {
      enter, note, base, kill, clear, control,
      get generation() { return generation; },
      get pendingEntries() { return branchEntries.size; },
      get pairWindow() { return window; },
    };
  }

  global.AddressProvenance = Object.freeze({ create, DEFAULT_WINDOW, CALLER_SAVED_LAST, LINK_REGISTER });
})(typeof globalThis !== 'undefined' ? globalThis : self);
