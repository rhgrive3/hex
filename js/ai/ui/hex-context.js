/*
 * app -> AI core local context.
 *
 * The AI core (js/ai/*) is written against a plain object of capabilities; the
 * Hex app is a class with workers, caches and BigInt regions. This adapter is
 * the seam between them and lives on the UI side on purpose: the core must not
 * learn about `app`, and the app must not learn about the core.
 *
 * Everything here is read-only. Mutations (rename, comment) go through the
 * proposal path in interaction/proposals.js, never through a tool.
 */
import { analyzeFunctionCached } from '../../analyze.js';
import { decompile, decompiledText } from '../../decompile.js';
import { runtimeEvidenceForApp, runtimePlatformForApp, verifyAppHypothesis } from '../../runtime/app-runtime.js';
import { functionNameOf, selectionOf } from './workbench.js';
import { currentFunctionAddr } from '../../tools.js';

const MAX_SELECTION_ROWS = 80;

function toBigInt(value) {
  if (value == null) return null;
  if (typeof value === 'bigint') return value;
  try { return BigInt(typeof value === 'string' && /^0x/i.test(value) ? value : String(value)); } catch { return null; }
}

function fixedRows(app) {
  const arch = String(app.store.get('architecture') || 'arm64').toLowerCase();
  return /arm64|aarch64/.test(arch) || !!app.store.get('canDisassemble');
}

/** Semantic model for one function, or null when it cannot be analysed. */
export async function analyzeModelAt(app, address) {
  const addr = toBigInt(address);
  if (addr == null) return null;
  const region = app.codeRegion?.() || app.store.get('currentRegion');
  if (!region || !app.store.get('canDisassemble')) return null;
  const sym = app.symbols;
  const fn = sym && sym.functionCount ? sym.functionAt(addr) : null;
  const start = fn ? fn.start : addr;
  if (start < region.vmAddr || start >= region.vmAddr + region.size) return null;
  const startRow = Number((start - region.vmAddr) / 4n);
  const totalRows = Number(region.size / 4n);
  const endRow = fn && fn.end != null
    ? Math.min(totalRows - 1, Number((fn.end - region.vmAddr) / 4n) - 1)
    : Math.min(totalRows - 1, startRow + 2048);
  if (endRow < startRow) return null;
  try {
    const res = await analyzeFunctionCached(app.backend, region, startRow, endRow, sym);
    return res && res.model ? res.model : null;
  } catch {
    return null;
  }
}

function selectionContext(app) {
  const viewer = app.viewer;
  const selection = selectionOf(app);
  if (!selection || !viewer) return null;
  const rows = [];
  if (selection.kind === 'range') {
    const range = viewer.selectionRange();
    const end = Math.min(range.end, range.start + MAX_SELECTION_ROWS - 1);
    for (let row = range.start; row <= end; row++) {
      const data = viewer.rowData(row);
      if (data && data.address != null) rows.push({ address: data.address, mnemonic: data.mnemonic, operands: data.operands });
    }
  } else if (selection.row != null) {
    const data = viewer.rowData(selection.row);
    if (data && data.address != null) rows.push({ address: data.address, mnemonic: data.mnemonic, operands: data.operands });
  }
  if (!rows.length) return null;
  return { start: rows[0].address, end: rows[rows.length - 1].address, instructions: rows };
}

/**
 * Build the capability object the AI core expects.
 *
 * Live getters, not a snapshot: the user keeps navigating while a turn runs,
 * and a stale "current function" is the fastest way to produce a confident
 * answer about the wrong code.
 */
export function createHexAIContext(app) {
  const nameOf = (addr) => functionNameOf(app, addr);

  const context = {
    get binaryId() {
      const info = app.store.get('fileInfo');
      return info ? info.name + ':' + String(app.store.get('sliceIndex')) : null;
    },
    get symbols() { return app.symbols; },
    get program() { return app.program; },
    get strings() { return app.stringIndex || []; },
    get candidateFunctions() {
      const addr = safeCurrentFunction(app);
      return addr == null ? [] : [addr];
    },
    get currentAddress() {
      const addr = safeCurrentFunction(app);
      return addr == null ? null : addr;
    },
    get activeFunction() {
      const addr = safeCurrentFunction(app);
      if (addr == null) return null;
      return { address: addr, name: nameOf(addr) };
    },
    get selection() { return selectionContext(app); },
    get project() {
      return {
        names: app.notes ? app.notes.nameEntries().slice(0, 400) : [],
        lastGoal: app.lastGoal ? app.lastGoal.text : null,
      };
    },

    functionName: nameOf,
    analyze: (address) => analyzeModelAt(app, address),

    async searchStrings(query, options = {}) {
      const limit = Math.max(1, Math.min(200, Number(options.limit) || 50));
      const rows = await app.ensureStrings();
      const q = String(query || '').toLowerCase();
      const out = [];
      for (const row of rows || []) {
        if (q && !String(row.text || '').toLowerCase().includes(q)) continue;
        /* `stringAddress` (not `addr`) on purpose: a string is not a function
           start, and the planner treats a bare address as a candidate. */
        out.push({ text: row.text, stringAddress: row.addr });
        if (out.length >= limit) break;
      }
      return out;
    },

    searchFunctions(query, options = {}) {
      const limit = Math.max(1, Math.min(200, Number(options.limit) || 40));
      const sym = app.symbols;
      if (!sym || !Array.isArray(sym.names)) return [];
      const q = String(query || '').toLowerCase();
      const out = [];
      for (let i = 0; i < sym.names.length && out.length < limit; i++) {
        const name = String(sym.names[i] || '');
        if (q && !name.toLowerCase().includes(q)) continue;
        out.push({ addr: sym.addrs[i], name });
      }
      return out;
    },

    async decompile(address) {
      if (!fixedRows(app)) return null;
      const model = await analyzeModelAt(app, address);
      if (!model) return null;
      return decompiledText(pseudocode(app, model, toBigInt(address), nameOf));
    },

    pseudocodeFor(address, model) {
      if (!model || !fixedRows(app)) return null;
      try { return decompiledText(pseudocode(app, model, toBigInt(address), nameOf)); } catch { return null; }
    },

    addressExists(address) {
      const addr = toBigInt(address);
      if (addr == null) return false;
      for (const region of app.store.get('regions') || []) {
        if (region.size > 0n && addr >= region.vmAddr && addr < region.vmAddr + region.size) return true;
      }
      return false;
    },

    runtime: {
      getObservations({ functionAddress, limit = 100 } = {}) {
        const addr = toBigInt(functionAddress);
        const results = runtimeEvidenceForApp(app, addr).slice(-limit);
        return { results, returned: results.length, verified: results.length > 0 };
      },
      async verifyHypothesis(hypothesis, options) {
        try { return await verifyAppHypothesis(app, hypothesis, options || {}); }
        catch (error) { return { verified: false, reason: String(error && error.message || error) }; }
      },
      async platform() { return runtimePlatformForApp(app); },
    },
  };
  return context;
}

function safeCurrentFunction(app) {
  try { return currentFunctionAddr(app); } catch { return null; }
}

function pseudocode(app, model, addr, nameOf) {
  const region = app.store.get('currentRegion');
  return decompile(model, {
    name: nameOf(addr),
    addr,
    rowOfAddress: (a) => (region && a != null ? Number((a - region.vmAddr) / 4n) : null),
    addrOfRow: (row) => (region ? region.vmAddr + BigInt(row) * 4n : null),
    symbolFor: (a) => app.symbols?.nameAt?.(a) || null,
    notes: app.notes,
  });
}

export default createHexAIContext;
