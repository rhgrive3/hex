/*
 * Sheets and dialogs: file info, section navigator, jump, search, instruction
 * detail, settings. They read the store and call back into the app; they never
 * touch the worker or Capstone directly.
 */
import { Sheet, el, button, list, groupRow, kvRow, tapRow, toast, copyText, alertDialog, menu } from './ui.js';
import { addrHex, addrText, sizeText, parseAddress, parseHexPattern } from './format.js';
import { rangeCopyMenu } from './rangecopy.js';

/* ── File info ──────────────────────────────────────────────── */

export function showFileInfo(app) {
  const info = app.store.get('fileInfo');
  if (!info) return;
  const sheet = new Sheet('File');
  const ul = list();

  ul.append(groupRow('FILE'));
  ul.append(kvRow('Name', info.name));
  ul.append(kvRow('Size', sizeText(info.size) + ' (' + info.size.toString() + ' bytes)'));
  ul.append(kvRow('Format', info.format));

  const slice = app.currentSlice();
  if (slice && slice.info) {
    const m = slice.info;
    ul.append(groupRow('MACH-O'));
    ul.append(kvRow('Type', m.filetypeName));
    ul.append(kvRow('CPU', m.cpu));
    ul.append(kvRow('CPU subtype', m.cpuSub));
    ul.append(kvRow('Magic', m.magic));
    ul.append(kvRow('Flags', '0x' + (m.flags >>> 0).toString(16).toUpperCase()));
    if (m.platform) ul.append(kvRow('Platform', m.platform + (m.minos ? ' ' + m.minos : ''), m.sdk ? 'SDK ' + m.sdk : null));
    if (m.uuid) ul.append(kvRow('UUID', m.uuid));
    ul.append(kvRow('Load commands', String(m.ncmds) + ' (' + sizeText(m.sizeofcmds) + ')'));
    ul.append(kvRow('Linked dylibs', String(m.dylibCount)));
    ul.append(kvRow('Code signature', m.hasCodeSignature ? 'Present' : 'None'));
    if (slice.offset > 0n) ul.append(kvRow('Slice offset', addrHex(slice.offset)));

    if (m.entry != null) {
      ul.append(tapRow('Entry point', {
        right: addrHex(m.entry),
        onTap: () => { sheet.close(); app.goToAddress(m.entry, { preferExec: true }); },
      }));
    }
    if (m.encryption) {
      ul.append(kvRow('Encryption', m.encrypted ? 'cryptid ' + m.encryption.cryptid + ' (encrypted)' : 'cryptid 0'));
      if (m.encrypted) {
        const li = el('li');
        li.append(el('span', 'sub warn',
          'This image is still App Store encrypted between ' +
          addrHex(m.encryption.cryptoff) + ' and ' +
          addrHex(m.encryption.cryptoff + m.encryption.cryptsize) +
          ' (file offsets). Code in that range will disassemble as noise until it is decrypted.'));
        ul.append(li);
      }
    }

    const codeRegions = app.store.get('regions').filter((r) => r.exec && r.size > 0n);
    if (codeRegions.length) {
      ul.append(groupRow('CODE'));
      for (const r of codeRegions) {
        ul.append(tapRow(r.name, {
          sub: addrHex(r.vmAddr) + ' – ' + addrHex(r.vmAddr + r.size) + '  ·  ' + sizeText(r.size),
          onTap: () => { sheet.close(); app.selectRegion(r); },
        }));
      }
    }

    if (m.commands && m.commands.length) {
      ul.append(groupRow('LOAD COMMANDS'));
      const counts = new Map();
      for (const c of m.commands) counts.set(c.name, (counts.get(c.name) || 0) + 1);
      for (const [name, n] of counts) ul.append(kvRow(name, n > 1 ? '× ' + n : '1'));
    }
  } else {
    ul.append(groupRow('CONTENT'));
    const li = el('li');
    li.append(el('span', 'sub',
      'No Mach-O header was found, so the whole file is shown as raw bytes. ' +
      'Use “Go to” to move to an offset, and the Assembly tab to disassemble it as ARM64.'));
    ul.append(li);
  }

  if (info.warnings && info.warnings.length) {
    ul.append(groupRow('NOTES'));
    for (const w of info.warnings) {
      const li = el('li');
      li.append(el('span', 'sub warn', w));
      ul.append(li);
    }
  }

  sheet.body.append(ul);
}

/* ── Sections / regions ─────────────────────────────────────── */

export function showSections(app) {
  const info = app.store.get('fileInfo');
  if (!info) return;
  const sheet = new Sheet('Sections');
  const ul = list();
  const current = app.store.get('currentRegion');

  if (info.slices.length > 1) {
    ul.append(groupRow('ARCHITECTURE'));
    info.slices.forEach((s, i) => {
      ul.append(tapRow(s.name, {
        sub: s.error ? s.error : sizeText(s.size) + ' at ' + addrHex(s.offset),
        right: i === app.store.get('sliceIndex') ? '✓' : '',
        disabled: !!s.error,
        onTap: () => { sheet.close(); app.selectSlice(i); },
      }));
    });
  }

  const slice = app.currentSlice();
  if (slice && slice.info) {
    for (const seg of slice.info.segments) {
      ul.append(groupRow(seg.name + '   ' + addrHex(seg.vmaddr) + ' · ' + sizeText(seg.vmsize)));
      if (!seg.sections.length) {
        ul.append(tapRow('(no sections)', { disabled: true, indent: true }));
      }
      for (const sec of seg.sections) {
        const region = app.store.get('regions').find(
          (r) => r.segment === sec.segment && r.section === sec.name && r.vmAddr === sec.addr);
        const disabled = !region || region.size === 0n;
        ul.append(tapRow(sec.name, {
          indent: true,
          sub: addrHex(sec.addr) + ' – ' + addrHex(sec.addr + sec.size) + '  ·  ' + sizeText(sec.size) +
               (sec.zerofill ? '  ·  zero-filled' : '') +
               (region && region.truncated ? '  ·  truncated in file' : ''),
          tag: sec.exec ? 'code' : (sec.zerofill ? 'bss' : ''),
          tagClass: sec.exec ? 'exec' : '',
          right: current && region && current.id === region.id ? '✓' : '',
          disabled,
          onTap: () => { sheet.close(); app.selectRegion(region); },
        }));
      }
    }
  }

  ul.append(groupRow('RAW'));
  ul.append(tapRow('Whole file', {
    sub: 'File offset 0 – ' + addrHex(info.size) + '  ·  ' + sizeText(info.size),
    right: current && current.id === 'raw' ? '✓' : '',
    onTap: () => { sheet.close(); app.selectRegion(info.raw); },
  }));

  sheet.body.append(ul);
}

/* ── Go to address ──────────────────────────────────────────── */

export function showJump(app) {
  const region = app.store.get('currentRegion');
  if (!region) return;
  const sheet = new Sheet('Go to Address');

  const field = el('div', 'field');
  const input = el('input');
  input.type = 'text';
  input.inputMode = 'text';
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = '0x' + addrText(region.vmAddr);
  field.append(input, button('Go', 'chip', go));
  sheet.body.append(field);

  const hint = el('div', 'hint',
    'Accepts 10000C448 or 0x10000C448. Current section covers ' +
    addrHex(region.vmAddr) + ' – ' + addrHex(region.vmAddr + region.size) + '.');
  sheet.body.append(hint);

  const quick = list();
  quick.append(groupRow('JUMP TO'));
  quick.append(tapRow('Start of section', {
    right: addrHex(region.vmAddr),
    onTap: () => { sheet.close(); app.goToAddress(region.vmAddr); },
  }));
  quick.append(tapRow('End of section', {
    right: addrHex(region.vmAddr + region.size),
    onTap: () => { sheet.close(); app.viewer.goToRow(app.viewer.totalRows - 1, 'top'); },
  }));
  const slice = app.currentSlice();
  if (slice && slice.info && slice.info.entry != null) {
    quick.append(tapRow('Entry point', {
      right: addrHex(slice.info.entry),
      onTap: () => { sheet.close(); app.goToAddress(slice.info.entry, { preferExec: true }); },
    }));
  }
  sheet.body.append(quick);

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  setTimeout(() => input.focus(), 50);

  function go() {
    const v = parseAddress(input.value);
    if (v == null) {
      toast('Enter a hexadecimal address, e.g. 0x10000C448.');
      return;
    }
    sheet.close();
    app.goToAddress(v, { announce: true });
  }
}

/* ── Search ─────────────────────────────────────────────────── */

export function showSearch(app) {
  const region = app.store.get('currentRegion');
  if (!region) return;
  const sheet = new Sheet('Search', {
    onClose: () => { app.backend.cancelSearch(); app.backend.onSearchProgress = null; },
  });

  let kind = app.store.get('searchKind') || 'asm';

  const chips = el('div', 'chips');
  const defs = [
    ['asm', 'Instruction'],
    ['hex', 'Hex bytes'],
    ['addr', 'Address'],
  ];
  const chipEls = new Map();
  for (const [k, label] of defs) {
    const c = button(label, 'chip', () => setKind(k));
    c.setAttribute('aria-pressed', String(k === kind));
    chipEls.set(k, c);
    chips.append(c);
  }

  const field = el('div', 'field');
  const input = el('input');
  input.type = 'search';
  input.autocapitalize = 'off';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.value = app.store.get('searchQuery') || '';
  const goBtn = button('Find', 'chip', () => (running ? stop() : run()));
  field.append(input, goBtn);

  const bar = el('div', 'progress');
  const fill = el('i');
  bar.append(fill);

  const status = el('div', 'hint', '');
  const results = list();

  sheet.body.append(chips, field, bar, status, results);
  setKind(kind);
  setTimeout(() => input.focus(), 50);

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

  let running = false;

  function setKind(k) {
    kind = k;
    app.store.set({ searchKind: k });
    for (const [key, c] of chipEls) c.setAttribute('aria-pressed', String(key === k));
    input.placeholder =
      k === 'asm' ? 'e.g. str, bl, x19, #0x20' :
      k === 'hex' ? 'e.g. FD 7B BF A9 or D1??00' :
      'e.g. 0x10000C448';
    status.textContent =
      k === 'asm' ? 'Searches mnemonics and operands in ' + region.name + '.' :
      k === 'hex' ? 'Searches raw bytes in ' + region.name + '. “?” matches any nibble.' :
      'Jumps straight to an address in ' + region.name + '.';
  }

  function run() {
    const q = input.value.trim();
    app.store.set({ searchQuery: q });
    if (!q) { toast('Enter something to search for.'); return; }

    if (kind === 'addr') {
      const v = parseAddress(q);
      if (v == null) { toast('That is not a valid address.'); return; }
      sheet.close();
      app.goToAddress(v, { announce: true });
      return;
    }
    if (running) app.backend.cancelSearch();

    results.replaceChildren();
    fill.style.width = '0%';
    status.textContent = 'Searching…';
    running = true;
    goBtn.textContent = 'Stop';

    const params = { regionId: region.id, kind, from: 0 };
    if (kind === 'hex') {
      const pat = parseHexPattern(q);
      if (!pat) { toast('Enter hex bytes such as FD 7B BF A9.'); running = false; goBtn.textContent = 'Find'; return; }
      params.hex = pat;
    } else {
      params.query = q;
    }

    app.backend.onSearchProgress = (p) => {
      if (!p.all) return;
      fill.style.width = Math.min(100, Math.round((p.done / p.all) * 100)) + '%';
      status.textContent = 'Searching… ' + p.hits + ' match' + (p.hits === 1 ? '' : 'es');
    };

    app.backend.search(params).then((res) => {
      running = false;
      goBtn.textContent = 'Find';
      app.backend.onSearchProgress = null;
      fill.style.width = '100%';
      if (res.cancelled) { status.textContent = 'Search stopped. ' + res.results.length + ' match(es) so far.'; }
      else if (!res.results.length) { status.textContent = 'No matches in ' + region.name + '.'; }
      else {
        status.textContent = res.results.length + ' match' + (res.results.length === 1 ? '' : 'es') +
          (res.capped ? ' (stopped at the first ' + res.results.length + ')' : '');
      }
      render(res.results);
    }).catch((err) => {
      running = false;
      goBtn.textContent = 'Find';
      app.backend.onSearchProgress = null;
      status.textContent = '';
      alertDialog('Search failed', err.message || String(err));
    });
  }

  function stop() {
    app.backend.cancelSearch();
    running = false;
    goBtn.textContent = 'Find';
    status.textContent = 'Search stopped.';
  }

  /* Results are paged: a thousand list rows would defeat the point of
     keeping the DOM small. */
  const PAGE = 150;

  function render(items) {
    results.replaceChildren();
    let shown = 0;
    const more = tapRow('Show more results', { onTap: () => page() });

    const page = () => {
      more.remove();
      const frag = document.createDocumentFragment();
      const end = Math.min(items.length, shown + PAGE);
      for (; shown < end; shown++) {
        const it = items[shown];
        frag.append(tapRow(addrText(it.addr), {
          sub: it.text,
          onTap: () => {
            sheet.close();
            app.viewer.goToRow(it.row, 'third');
            app.viewer.mark(it.row);
            app.viewer.select(it.row, false);
            app.store.set({ selectedRow: it.row });
          },
        }));
      }
      results.append(frag);
      if (shown < items.length) {
        more.replaceChildren();
        more.append(el('div', null, 'Show ' + Math.min(PAGE, items.length - shown) + ' more'));
        results.append(more);
      }
    };
    if (items.length) page();
  }
}

/* ── Instruction detail ─────────────────────────────────────── */

export function showDetail(app, row) {
  const sheet = new Sheet('Instruction', {
    anchor: 'bottom', dim: 'light',
    onClose: () => { app.detailRefresh = null; },
  });
  const grid = el('div', 'detail-grid');
  const actions = el('div', 'detail-actions');
  sheet.body.append(grid, actions);

  const fields = {};
  for (const [key, label] of [['address', 'ADDRESS'], ['bytes', 'BYTES'], ['mnemonic', 'MNEMONIC'], ['operands', 'OPERANDS']]) {
    grid.append(el('div', 'dk', label));
    fields[key] = el('div', 'dv', '…');
    grid.append(fields[key]);
  }
  const meta = el('div', 'hint', '');
  sheet.body.append(meta);

  const refresh = () => {
    const d = app.viewer.rowData(row);
    if (!d) return;
    fields.address.textContent = addrHex(d.address);
    fields.bytes.textContent = d.bytes || '…';
    fields.mnemonic.textContent = d.mnemonic == null ? (app.store.get('canDisassemble') ? '…' : '—') : d.mnemonic;
    fields.operands.textContent = d.operands == null ? '' : d.operands;
    const region = app.store.get('currentRegion');
    if (region) {
      const off = region.fileOffset + BigInt(row) * 4n;
      meta.textContent = 'Section ' + region.name + '  ·  file offset ' + addrHex(off) +
        '  ·  row ' + row.toLocaleString();
    }
    return d;
  };
  refresh();
  app.detailRefresh = refresh;

  const copy = (what) => {
    const d = app.viewer.rowData(row) || {};
    if (what === 'address') copyText(addrHex(d.address), 'Address');
    else if (what === 'hex') copyText(d.bytes || '', 'Bytes');
    else if (what === 'asm') copyText(((d.mnemonic || '') + ' ' + (d.operands || '')).trim(), 'Instruction');
    else {
      const text = addrHex(d.address) + '\t' + (d.bytes || '') + '\t' +
        ((d.mnemonic || '') + ' ' + (d.operands || '')).trim();
      copyText(text, 'Row');
    }
  };
  actions.append(
    button('Copy Address', 'chip', () => copy('address')),
    button('Copy Hex', 'chip', () => copy('hex')),
    button('Copy Assembly', 'chip', () => copy('asm')),
    button('Copy All', 'chip', () => copy('all')),
    button('Select Rows…', 'chip', () => { sheet.close(); app.startSelection(row); }));
}

export function instructionMenu(app, row, x, y) {
  // Long-pressing while a range is being picked moves its end (the viewer has
  // already done that by now), so the menu is about the range, not the row.
  const sel = app.viewer.rangeMode ? app.viewer.selectionRange() : null;
  if (sel) { rangeCopyMenu(app, x, y); return; }

  const d = app.viewer.rowData(row) || {};
  const asm = ((d.mnemonic || '') + ' ' + (d.operands || '')).trim();
  menu([
    { label: 'Copy Address', action: () => copyText(addrHex(d.address), 'Address') },
    { label: 'Copy Hex', action: () => copyText(d.bytes || '', 'Bytes') },
    { label: 'Copy Assembly', action: () => copyText(asm, 'Instruction') },
    { label: 'Copy All', action: () => copyText(addrHex(d.address) + '\t' + (d.bytes || '') + '\t' + asm, 'Row') },
    '-',
    { label: 'Select Rows from Here', action: () => app.startSelection(row) },
    { label: 'Show Details…', action: () => showDetail(app, row) },
  ], x, y);
}

/* ── Settings ───────────────────────────────────────────────── */

export function showSettings(app) {
  const sheet = new Sheet('Settings');
  const ul = list();

  ul.append(groupRow('APPEARANCE'));
  const themes = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];
  for (const [key, label] of themes) {
    ul.append(tapRow(label, {
      right: app.store.get('theme') === key ? '✓' : '',
      onTap: () => { app.setTheme(key); sheet.close(); showSettings(app); },
    }));
  }

  ul.append(groupRow('HEX'));
  ul.append(tapRow('Spaced bytes', {
    sub: 'F6 57 BD A9',
    right: app.store.get('hexJoined') ? '' : '✓',
    onTap: () => { app.setHexJoined(false); sheet.close(); showSettings(app); },
  }));
  ul.append(tapRow('Joined bytes', {
    sub: 'F657BDA9',
    right: app.store.get('hexJoined') ? '✓' : '',
    onTap: () => { app.setHexJoined(true); sheet.close(); showSettings(app); },
  }));

  ul.append(groupRow('ABOUT'));
  const li = el('li');
  li.append(el('span', 'sub',
    'Everything runs locally in this browser: the file you open is read with the ' +
    'File API, parsed in a Web Worker and never uploaded or modified. ' +
    'Disassembly is Capstone ' + (app.capstoneVersion || '5') + ' compiled to WebAssembly.'));
  ul.append(li);

  sheet.body.append(ul);
}
