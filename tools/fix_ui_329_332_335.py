from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def rep(path, old, new, count=1):
    p=ROOT/path; s=p.read_text()
    if old not in s: raise RuntimeError(f'missing {path}: {old[:120]!r}')
    p.write_text(s.replace(old,new,count))

# #329 — use graph-theoretic backEdges emitted by controlflow.js.
rep('js/graphview.js',
"""  const edges = [];
  for (const b of blocks) {""",
"""  const edges = [];
  const backEdges = new Set((model.backEdges || []).map((e) => `${e.from}:${e.to}`));
  const isBackEdge = (fromBlock, toBlock, terminalRow) => {
    if (toBlock == null || toBlock < 0) return false;
    const target = blocks[toBlock];
    return !!target && backEdges.has(`${terminalRow}:${target.startRow}`);
  };
  for (const b of blocks) {""")
rep('js/graphview.js',
"""      if (ti >= 0) edges.push({ from: b.index, to: ti, kind: ti <= b.index ? 'back' : 'true', label: '成り立つ' });""",
"""      if (ti >= 0) edges.push({ from: b.index, to: ti, kind: isBackEdge(b.index, ti, last.row) ? 'back' : 'true', label: '成り立つ' });""")
rep('js/graphview.js',
"""      if (ti >= 0) edges.push({ from: b.index, to: ti, kind: ti <= b.index ? 'back' : 'jump' });""",
"""      if (ti >= 0) edges.push({ from: b.index, to: ti, kind: isBackEdge(b.index, ti, last.row) ? 'back' : 'jump' });""")

# #330 — persist gesture suppression through the synthetic click following pointerup.
rep('js/graphview.js',
"""  let pinch = 0;
  let last = null;""",
"""  let pinch = 0;
  let last = null;
  let suppressClick = false;
  let multiTouchGesture = false;""")
rep('js/graphview.js',
"""    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (points.size === 1) {
      last = { x: e.clientX, y: e.clientY, moved: false };""",
"""    if (points.size === 0) { suppressClick = false; multiTouchGesture = false; }
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (points.size === 1) {
      last = { x: e.clientX, y: e.clientY, moved: false };""")
rep('js/graphview.js',
"""    } else if (points.size === 2) {
      pinch = spread(points);""",
"""    } else if (points.size === 2) {
      multiTouchGesture = true;
      pinch = spread(points);""")
rep('js/graphview.js',
"""    if (!points.size) { wrap.classList.remove('dragging'); last = null; }
  };""",
"""    if (!points.size) {
      wrap.classList.remove('dragging');
      suppressClick = !!(last && last.moved) || multiTouchGesture;
      last = null;
    }
  };""")
rep('js/graphview.js',
"""  wrap.addEventListener('click', (e) => {
    if (last && last.moved) { e.stopPropagation(); e.preventDefault(); }
  }, true);""",
"""  wrap.addEventListener('click', (e) => {
    if (suppressClick) {
      suppressClick = false;
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);""")

# #331 — local files are rejected by byte size before File.text() allocates a string.
rep('js/tools.js',
"""import { EXAMPLE_PLUGIN } from './plugins.js';""",
"""import { EXAMPLE_PLUGIN, MAX_PLUGIN_SOURCE_BYTES } from './plugins.js';""")
rep('js/tools.js',
"""        const f = picker.files && picker.files[0];
        if (!f) return;
        const text = await f.text();
        confirmInstall(text, f.name);""",
"""        const f = picker.files && picker.files[0];
        if (!f) return;
        if (f.size > MAX_PLUGIN_SOURCE_BYTES) {
          toast('プラグインが大きすぎます（512 KB まで）。');
          return;
        }
        const text = await f.text();
        confirmInstall(text, f.name);""")

# #332 — strict argument parser; never silently substitute zero.
insert = """
export function parseDebuggerArgument(value) {
  const raw = String(value ?? '');
  if (!raw || raw !== raw.trim() || !/^-?(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(raw)) {
    return { ok: false, value: null, error: '10進整数か0x付き16進整数を入力してください。' };
  }
  try { return { ok: true, value: BigInt(raw), error: null }; }
  catch { return { ok: false, value: null, error: '整数として読み取れません。' }; }
}

"""
marker="/* ══════════════════════════════════════════════════════════\n   入口: 道具箱"
p=ROOT/'js/tools.js'; s=p.read_text(); idx=s.find(marker)
if idx<0: raise RuntimeError('tools insertion marker missing')
p.write_text(s[:idx]+insert+s[idx:])
rep('js/tools.js',
"""  const start = () => {
    args = argInputs.map((n) => {
      const v = n.value.trim();
      try { return v ? BigInt(v) : 0n; } catch { return 0n; }
    });
    const keep = new Set(emu.breakpoints);""",
"""  const start = () => {
    const parsed = argInputs.map((n) => parseDebuggerArgument(n.value));
    let invalid = false;
    parsed.forEach((result, i) => {
      const inputNode = argInputs[i];
      inputNode.setAttribute('aria-invalid', String(!result.ok));
      inputNode.classList.toggle('invalid', !result.ok);
      if (!result.ok) invalid = true;
    });
    if (invalid) {
      status.textContent = '引数に読み取れない値があります。赤く示した欄を直してください。';
      return false;
    }
    args = parsed.map((result) => result.value);
    const keep = new Set(emu.breakpoints);""")

# #335 — centralize address/row conversion on the viewer and stop /4 consumers.
# Viewer exposes a single mapping API. Variable-width architectures return null
# unless a decoded instruction address table is supplied.
rep('js/viewer.js',
"""  topAddress() {
    if (!this.region) return null;
    return this.region.vmAddr + BigInt(this.topRow()) * 4n;
  }

  rowAddress(row) {
    return this.region.vmAddr + BigInt(row) * 4n;
  }""",
"""  fixedInstructionSize() {
    const cap = this.region?.capability || this.backend?.platformInfo?.capability || this.backend?.legacyInfo?.capability || null;
    if (cap && Object.prototype.hasOwnProperty.call(cap, 'fixedInstructionSize')) {
      const n = cap.fixedInstructionSize;
      return Number.isInteger(n) && n > 0 ? n : null;
    }
    // Legacy viewer is ARM64-only.
    return this.region?.disasm === false ? null : 4;
  }

  rowOfAddress(addr) {
    if (!this.region || addr == null) return null;
    const rel = addr - this.region.vmAddr;
    if (rel < 0n || rel >= this.region.size) return null;
    const width = this.fixedInstructionSize();
    if (!width) return null;
    const w = BigInt(width);
    if (rel % w !== 0n) return null;
    return Number(rel / w);
  }

  topAddress() {
    if (!this.region) return null;
    return this.rowAddress(this.topRow());
  }

  rowAddress(row) {
    if (!this.region) return null;
    const width = this.fixedInstructionSize();
    if (!width) return null;
    return this.region.vmAddr + BigInt(row) * BigInt(width);
  }""")
rep('js/viewer.js',
"""  goToAddress(addr) {
    if (!this.region) return false;
    const rel = addr - this.region.vmAddr;
    if (rel < 0n || rel >= this.region.size) return false;
    this.goToRow(Number(rel / 4n), 'third');
    return true;
  }""",
"""  goToAddress(addr) {
    const row = this.rowOfAddress(addr);
    if (row == null) return false;
    this.goToRow(row, 'third');
    return true;
  }""")
rep('js/tools.js',
"""    const addr = region.vmAddr + BigInt(row) * 4n;""",
"""    const addr = app.viewer?.rowAddress ? app.viewer.rowAddress(row) : null;
    if (addr == null) return null;""")
rep('js/tools.js',
"""  return {
    rowOfAddress: (a) => {
      if (a == null || !region) return null;
      const rel = a - region.vmAddr;
      if (rel < 0n || rel >= region.size) return null;
      return Number(rel / 4n);
    },
    addrOfRow: (row) => (region ? region.vmAddr + BigInt(row) * 4n : null),
  };""",
"""  return {
    rowOfAddress: (a) => (a == null || !region || !app.viewer?.rowOfAddress ? null : app.viewer.rowOfAddress(a)),
    addrOfRow: (row) => (region && app.viewer?.rowAddress ? app.viewer.rowAddress(row) : null),
  };""")
rep('js/tools.js',
"""  const row = Number((addr - region.vmAddr) / 4n);
  const chunk = Math.floor(row / 1024);""",
"""  const row = app.viewer?.rowOfAddress ? app.viewer.rowOfAddress(addr) : null;
  if (row == null) {
    // Variable-length ISA: ask the architecture backend for an instruction at
    // this exact address rather than manufacturing a 4-byte row.
    const decoded = await app.backend.disassembleAt(addr, { length: 32 });
    const hit = decoded?.instructions?.find((i) => i.address === addr || BigInt(i.address ?? -1) === addr);
    return hit ? { mnemonic: hit.mnemonic || hit.mn || '', operands: hit.operands || hit.opStr || '', address: addr } : null;
  }
  const chunk = Math.floor(row / 1024);""")

# AI actions use viewer/model canonical mappings.
rep('js/ai/interaction/actions.js',
"""      const row = Number((addr - region.vmAddr) / 4n);
      app.viewer.select(row, false);
      app.store.set({ selectedRow: row });""",
"""      const row = app.viewer?.rowOfAddress ? app.viewer.rowOfAddress(addr) : null;
      if (row != null) {
        app.viewer.select(row, false);
        app.store.set({ selectedRow: row });
      }""")
rep('js/ai/interaction/actions.js',
"""        const row = model && region ? Number((addr - region.vmAddr) / 4n) : null;
        if (model && row != null && Number.isFinite(row)) showValueFlow(app, model, row, region);""",
"""        const insn = model?.instructions?.find((i) => i.address === addr);
        const row = insn?.row ?? (app.viewer?.rowOfAddress ? app.viewer.rowOfAddress(addr) : null);
        if (model && row != null && Number.isFinite(row)) showValueFlow(app, model, row, region);""")

# App selection/flash similarly consume viewer mapping and honor navigation failure.
rep('js/app.js',
"""      this.viewer.goToAddress(addr);
      if (announce) this.flash(addr);""",
"""      if (!this.viewer.goToAddress(addr)) return false;
      if (announce) this.flash(addr);""", 1)
rep('js/app.js',
"""      this.viewer.goToAddress(addr);
      toast(t('toast.jumped', { name: target.name }));""",
"""      if (!this.viewer.goToAddress(addr)) return false;
      toast(t('toast.jumped', { name: target.name }));""", 1)
rep('js/app.js',
"""    const row = Number((addr - region.vmAddr) / 4n);
    this.viewer.select(row, false);
    this.store.set({ selectedRow: row });""",
"""    const row = this.viewer.rowOfAddress(addr);
    if (row == null) return;
    this.viewer.select(row, false);
    this.store.set({ selectedRow: row });""", 1)
rep('js/app.js',
"""    const row = Number((addr - region.vmAddr) / 4n);
    this.viewer.mark(row);""",
"""    const row = this.viewer.rowOfAddress(addr);
    if (row != null) this.viewer.mark(row);""", 1)

print('UI fixes applied')
