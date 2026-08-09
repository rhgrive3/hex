/*
 * Range copy: turn a selection of rows into text on the clipboard.
 *
 * A selection is rows, not bytes — ARM64 is fixed width, so one row is always
 * one address and four bytes. The rows are gathered chunk by chunk straight
 * from the backend (they need not have been on screen, and the section may be
 * far larger than the cache), which is why the whole path is asynchronous and
 * the clipboard write is handed a promise rather than a string.
 */
import { CHUNK_ROWS } from './backend.js';
import { addrHex, bytesHex, sizeText } from './format.js';
import { menu, alertDialog, copyTextLazy } from './ui.js';

/* A cap, not a limit of the format: 200k rows is ~10 MB of text, which is
   about as much as mobile Safari will take without a long stall. */
export const MAX_COPY_ROWS = 200_000;

const MN_COL = 6;               // mnemonic column width, like the row display

/** Menu items for the current selection; empty when nothing is selected. */
export function rangeCopyItems(app) {
  const sel = app.viewer.selectionRange();
  if (!sel) return [];
  const rows = sel.count.toLocaleString() + (sel.count === 1 ? ' Row' : ' Rows');
  const items = [
    { label: 'Copy ' + rows, action: () => copyRange(app, 'all') },
    { label: 'Copy Addresses', action: () => copyRange(app, 'address') },
    { label: 'Copy Hex', action: () => copyRange(app, 'hex') },
  ];
  if (app.store.get('canDisassemble')) {
    items.push({ label: 'Copy Assembly', action: () => copyRange(app, 'asm') });
  }
  return items;
}

export function rangeCopyMenu(app, x, y) {
  const items = rangeCopyItems(app);
  if (!items.length) return;
  items.push('-',
    { label: 'Select All Rows', action: () => app.viewer.selectAllRows() },
    { label: 'Clear Selection', action: () => app.viewer.clearRange() });
  menu(items, x, y);
}

/** what: 'all' | 'address' | 'hex' | 'asm' */
export function copyRange(app, what) {
  const region = app.store.get('currentRegion');
  const sel = app.viewer.selectionRange();
  if (!region || !sel) return;

  if (sel.count > MAX_COPY_ROWS) {
    alertDialog('Selection too large',
      sel.count.toLocaleString() + ' rows is more than can be put on the clipboard in one go. ' +
      'Select at most ' + MAX_COPY_ROWS.toLocaleString() + ' rows (' + sizeText(MAX_COPY_ROWS * 4) + ' of code).');
    return;
  }

  const wantAsm = (what === 'asm' || what === 'all') &&
    !!app.store.get('canDisassemble') && region.disasm !== false;
  const label = sel.count.toLocaleString() + (sel.count === 1 ? ' row' : ' rows');

  app.setBusy(true, 'Copying ' + label + '…');
  const text = buildText(app, region, sel, what, wantAsm)
    .finally(() => app.setBusy(false));

  copyTextLazy(text, label);
}

async function buildText(app, region, sel, what, wantAsm) {
  const spaced = !app.store.get('hexJoined');
  const first = Math.floor(sel.start / CHUNK_ROWS);
  const last = Math.floor(sel.end / CHUNK_ROWS);
  const out = [];

  for (let c = first; c <= last; c++) {
    // Switching section or file mid-copy would silently mix two regions.
    if (app.store.get('currentRegion') !== region) {
      throw new Error('The section changed while copying.');
    }
    const entry = await app.backend.fetchChunk(region.id, c, wantAsm);
    const base = c * CHUNK_ROWS;
    const from = Math.max(sel.start, base);
    const to = Math.min(sel.end, base + CHUNK_ROWS - 1);

    for (let row = from; row <= to; row++) {
      const idx = row - base;
      const off = idx * 4;
      const avail = entry.bytes ? Math.min(4, entry.bytes.length - off) : 0;
      const hex = avail > 0 ? bytesHex(entry.bytes, off, avail, spaced) : '';
      const mn = entry.mn ? (entry.mn[idx] || '') : '';
      const ops = entry.ops ? (entry.ops[idx] || '') : '';

      if (what === 'address') {
        out.push(addrHex(app.viewer.rowAddress(row)));
      } else if (what === 'hex') {
        out.push(hex);
      } else if (what === 'asm') {
        out.push(ops ? mn.padEnd(MN_COL) + ' ' + ops : mn);
      } else {
        const cells = [addrHex(app.viewer.rowAddress(row)), hex];
        if (wantAsm) cells.push((mn + ' ' + ops).trim());
        out.push(cells.join('\t'));
      }
    }

    if (last > first) {
      const done = Math.round(((c - first + 1) / (last - first + 1)) * 100);
      app.setBusy(true, 'Copying ' + sel.count.toLocaleString() + ' rows… ' + done + '%');
    }
  }
  return out.join('\n');
}
