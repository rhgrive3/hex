/*
 * Workbench state -> assistant context.
 *
 * The AI never reads the app object. Everything it is allowed to know about
 * the current screen passes through this one adapter, which keeps the
 * assistant honest (nothing here is an analysis result) and keeps the app
 * free to change shape without touching prompts or renderers.
 */
import { addrHex } from '../../format.js';
import { currentFunctionAddr, prettyName } from '../../tools.js';

function safe(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

export function functionNameOf(app, addr) {
  if (addr == null) return null;
  const raw = safe(() => app.symbols && (app.symbols.nameAt?.(addr) || app.symbols.label?.(addr)));
  if (raw) return prettyName(raw);
  return 'sub_' + BigInt(addr).toString(16).toUpperCase();
}

/** The instruction or range the user currently has selected, if any. */
export function selectionOf(app) {
  const viewer = app.viewer;
  if (!viewer) return null;
  if (viewer.rangeMode) {
    const range = safe(() => viewer.selectionRange());
    if (range) {
      return {
        kind: 'range',
        address: safe(() => addrHex(viewer.rowAddress(range.start))) || null,
        addressValue: safe(() => viewer.rowAddress(range.start)),
        text: range.count + ' rows',
        rows: range.count,
      };
    }
  }
  const row = viewer.selectedRow;
  if (row == null || row < 0) return null;
  const data = safe(() => viewer.rowData(row)) || {};
  if (data.address == null) return null;
  return {
    kind: 'instruction',
    address: safe(() => addrHex(data.address)) || null,
    addressValue: data.address,
    row,
    text: [data.mnemonic, data.operands].filter(Boolean).join(' ').trim(),
  };
}

export function currentFunctionOf(app) {
  const addr = safe(() => currentFunctionAddr(app));
  if (addr == null) return null;
  const owner = safe(() => app.ownerOf?.(addr));
  const callers = safe(() => (app.program ? app.program.callCountOf(addr) : null));
  const instructions = safe(() => (app.semantic && app.semantic.model && app.semantic.result
    && app.semantic.result.startAddr === addr ? app.semantic.model.instructions.length : null));
  return {
    address: safe(() => addrHex(addr)),
    addressValue: addr,
    name: functionNameOf(app, addr),
    owner: owner && owner.className ? owner.className + (owner.sel ? ' · ' + owner.sel : '') : null,
    callers: Number.isFinite(callers) ? callers : null,
    instructions: Number.isFinite(instructions) ? instructions : null,
  };
}

/**
 * Everything the assistant is allowed to know about the current screen.
 * `state` is for scope resolution; the rest is rendered into the prompt.
 */
export function workbenchContext(app) {
  const info = app.store.get('fileInfo');
  const region = app.store.get('currentRegion');
  const fn = info ? currentFunctionOf(app) : null;
  const selection = info ? selectionOf(app) : null;
  const notes = [];
  if (region) notes.push('open region: ' + (region.section || region.name));
  if (app.lastGoal && app.lastGoal.text) notes.push('last investigation: ' + app.lastGoal.text);
  if (app.notes && safe(() => app.notes.commentCount())) notes.push('user comments: ' + app.notes.commentCount());

  return {
    binary: info ? {
      name: info.name,
      format: info.format,
      architecture: app.store.get('architecture') || null,
    } : null,
    function: fn,
    selection,
    notes,
    state: {
      fileOpen: !!info,
      functionAddress: fn ? fn.addressValue : null,
      selection: selection ? selection.kind : null,
    },
  };
}

export default workbenchContext;
