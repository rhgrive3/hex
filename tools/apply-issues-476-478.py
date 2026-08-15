from pathlib import Path


def replace_once(text, old, new, label):
    if new in text:
        return text
    if old not in text:
        raise SystemExit(f'missing patch anchor: {label}')
    return text.replace(old, new, 1)

# ---------------------------------------------------------------------------
# Source-backed cryptographic full-content identity.
# ---------------------------------------------------------------------------
p = Path('js/platform/hash.js')
s = p.read_text()
if 'export async function sha256TreeByteSource' not in s:
    s += r'''

function bytesHex(bytes) {
  return Array.from(bytes || []).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Cryptographic identity for a ByteSource without materializing the whole file.
 * Every byte participates: each fixed-size chunk is SHA-256 hashed, then an
 * ordered, domain-separated manifest of those digests is SHA-256 hashed again.
 * This is a tree/content hash, not the conventional SHA-256(file) encoding.
 */
export async function sha256TreeByteSource(input, options = {}) {
  const source = asByteSource(input);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    const error = new Error('SubtleCrypto SHA-256 is unavailable');
    error.code = 'SHA256_UNAVAILABLE';
    throw error;
  }
  const chunkSize = Math.min(options.chunkSize ?? 4 * 1024 * 1024, source.maxReadLength);
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new TypeError('chunkSize must be a positive safe integer');

  const digests = [];
  let offset = 0n;
  while (offset < source.size) {
    if (options.signal?.aborted) {
      const error = new Error('hash cancelled');
      error.name = 'AbortError';
      error.code = 'ABORT_ERR';
      throw error;
    }
    const remaining = source.size - offset;
    const length = Number(remaining < BigInt(chunkSize) ? remaining : BigInt(chunkSize));
    const bytes = await source.readExactly(offset, length, { signal: options.signal });
    digests.push(new Uint8Array(await subtle.digest('SHA-256', bytes)));
    offset += BigInt(bytes.byteLength);
    options.onProgress?.({ done: offset, total: source.size });
  }

  const header = new TextEncoder().encode(
    `hex-sha256-tree-v1\0${source.size.toString()}\0${chunkSize}\0${digests.length}\0`);
  const manifest = new Uint8Array(header.byteLength + digests.length * 32);
  manifest.set(header, 0);
  let at = header.byteLength;
  for (const digest of digests) { manifest.set(digest, at); at += digest.byteLength; }
  const root = new Uint8Array(await subtle.digest('SHA-256', manifest));
  return `sha256tree:v1:${source.size.toString(16)}:${bytesHex(root)}`;
}
'''
    p.write_text(s)

# ---------------------------------------------------------------------------
# NoteStore: v3 full-content key, v2 migration, explicit persistence outcome,
# and clear tombstone so old migration sources can never resurrect deleted data.
# ---------------------------------------------------------------------------
p = Path('js/names.js')
s = p.read_text()
if "from './platform/hash.js'" not in s:
    s = s.replace("const PREFIX = 'hex.notes.';", "import { asByteSource } from './binary/source.js';\nimport { hashByteSource, sha256TreeByteSource } from './platform/hash.js';\n\nconst PREFIX = 'hex.notes.';", 1)
start = s.index('export async function noteKeyFor(file, fileInfo, sliceIndex) {')
end = s.index('\n\nexport class NoteStore', start)
new_key_code = r'''export async function legacyV2NoteKeyFor(file, fileInfo, sliceIndex) {
  if (!file) return null;
  const slices = fileInfo && fileInfo.slices || [];
  const slice = Number.isInteger(sliceIndex) && sliceIndex >= 0 ? slices[sliceIndex] : null;
  const info = slice && slice.info;
  const identity = [
    'v2', String(file.size == null ? 0 : file.size),
    info && info.uuid || '', info && info.cpu || '', info && info.cpuSub || '',
    slice && slice.offset != null ? slice.offset.toString() : '',
  ].join('|');
  const chunk = 64 * 1024;
  const size = Number(file.size || 0);
  const starts = Array.from(new Set([0, Math.max(0, Math.floor(size / 2) - Math.floor(chunk / 2)), Math.max(0, size - chunk)]));
  const pieces = [new TextEncoder().encode(identity)];
  for (const sampleStart of starts) {
    const bytes = new Uint8Array(await file.slice(sampleStart, Math.min(size, sampleStart + chunk)).arrayBuffer());
    pieces.push(bytes);
  }
  const total = pieces.reduce((n, piece) => n + piece.length, 0);
  const input = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) { input.set(piece, at); at += piece.length; }
  let digest;
  if (globalThis.crypto && globalThis.crypto.subtle) {
    digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input));
  } else {
    let h = 2166136261;
    for (const b of input) { h ^= b; h = Math.imul(h, 16777619); }
    digest = Uint8Array.from([(h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255]);
  }
  return identity + '|sha256:' + Array.from(digest).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function noteKeyFor(file, fileInfo, sliceIndex) {
  if (!file) return null;
  const slices = fileInfo && fileInfo.slices || [];
  const slice = Number.isInteger(sliceIndex) && sliceIndex >= 0 ? slices[sliceIndex] : null;
  const info = slice && slice.info;
  const source = asByteSource(file);
  let content = source;
  let sliceOffset = null;
  let sliceSize = null;
  if (slice && slice.offset != null && slice.size != null) {
    try {
      sliceOffset = BigInt(slice.offset);
      sliceSize = BigInt(slice.size);
      if (sliceOffset >= 0n && sliceSize >= 0n && sliceOffset <= source.size && sliceSize <= source.size - sliceOffset) {
        content = source.subrange(sliceOffset, sliceSize);
      } else {
        sliceOffset = null; sliceSize = null;
      }
    } catch { sliceOffset = null; sliceSize = null; }
  }
  const identity = [
    'v3', source.size.toString(),
    info && info.uuid || '', info && info.cpu || '', info && info.cpuSub || '',
    sliceOffset == null ? '' : sliceOffset.toString(),
    sliceSize == null ? '' : sliceSize.toString(),
  ].join('|');

  let digest;
  try {
    digest = await sha256TreeByteSource(content);
  } catch (error) {
    if (error?.code !== 'SHA256_UNAVAILABLE') throw error;
    // Legacy browser fallback still reads every byte. Modern Safari/iPadOS uses
    // the cryptographic path above; this exists only to avoid making notes unusable.
    digest = await hashByteSource(content);
  }
  return identity + '|' + digest;
}'''
s = s[:start] + new_key_code + s[end:]

s = replace_once(s,
"""    this.migratedFrom = null;\n    this.names = new Map();""",
"""    this.migratedFrom = null;\n    this.lastSaveError = null;\n    this.lastMutationSaved = true;\n    this.names = new Map();""", 'NoteStore constructor status')

s = replace_once(s,
"""      const o = JSON.parse(raw);\n      for (const [k, v] of Object.entries(o.names || {})) this.names.set(k, v);""",
"""      const o = JSON.parse(raw);\n      if (o && o.cleared === true) {\n        this.dirty = false;\n        this.lastSaveError = null;\n        this.lastMutationSaved = true;\n        this.migratedFrom = null;\n        return;\n      }\n      for (const [k, v] of Object.entries(o.names || {})) this.names.set(k, v);""", 'clear tombstone load')

save_start = s.index('  save() {')
save_end = s.index('\n\n  /* ── 名前', save_start)
new_save = r'''  _saveFailure(code, error = null, detail = {}) {
    this.dirty = true;
    this.lastMutationSaved = false;
    this.lastSaveError = {
      code: code || 'STORAGE_ERROR',
      message: error?.message || String(error || ''),
      ...detail,
    };
    return false;
  }

  save() {
    if (!this.id) return this._saveFailure('NO_ID');
    const o = {
      v: 2,
      names: Object.fromEntries(this.names),
      comments: Object.fromEntries(this.comments),
      vars: Object.fromEntries(this.vars),
      types: Object.fromEntries(this.types),
      structs: this.structs,
    };
    let text;
    try { text = JSON.stringify(o); } catch (error) { return this._saveFailure('SERIALIZE_ERROR', error); }
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > MAX_BYTES) return this._saveFailure('TOO_LARGE', null, { bytes, maxBytes: MAX_BYTES });
    try {
      localStorage.setItem(PREFIX + this.id, text);
      this.dirty = false;
      this.lastSaveError = null;
      this.lastMutationSaved = true;
      return true;
    } catch (error) {
      return this._saveFailure(error?.name || 'STORAGE_ERROR', error);
    }
  }'''
s = s[:save_start] + new_save + s[save_end:]

for old, new, label in [
("""    if (!k) return;\n    const clean = cleanName(name);""", """    if (!k) return this._saveFailure('INVALID_KEY');\n    const clean = cleanName(name);""", 'setName invalid'),
("""    this.dirty = true;\n    this.save();\n  }\n\n  /** 保存済みの名前""", """    this.dirty = true;\n    return this.save();\n  }\n\n  /** 保存済みの名前""", 'setName result'),
("""    if (!k) return;\n    const clean = (text || '').toString().slice(0, 500).trim();""", """    if (!k) return this._saveFailure('INVALID_KEY');\n    const clean = (text || '').toString().slice(0, 500).trim();""", 'setComment invalid'),
("""    this.dirty = true;\n    this.save();\n  }\n\n  commentCount()""", """    this.dirty = true;\n    return this.save();\n  }\n\n  commentCount()""", 'setComment result'),
("""    this.dirty = true;\n    this.save();\n  }\n\n  typeOf(func, k)""", """    this.dirty = true;\n    return this.save();\n  }\n\n  typeOf(func, k)""", 'setVarName result'),
("""    this.dirty = true;\n    this.save();\n  }\n\n  /* ── まとめて""", """    this.dirty = true;\n    return this.save();\n  }\n\n  /* ── まとめて""", 'setType result'),
]:
    s = replace_once(s, old, new, label)

clear_start = s.index('  clear() {')
clear_end = s.index('\n\n  /** 書き出し', clear_start)
new_clear = r'''  clear() {
    this.names.clear(); this.comments.clear(); this.vars.clear(); this.types.clear();
    this.structs = [];
    this.dirty = true;
    if (!this.id) return this._saveFailure('NO_ID');
    // Keep the legacy payload intact for old app versions, but atomically write
    // a primary-key tombstone so this version never migrates it again.
    try {
      localStorage.setItem(PREFIX + this.id, JSON.stringify({ v: 2, cleared: true }));
      this.dirty = false;
      this.lastSaveError = null;
      this.lastMutationSaved = true;
      this.migratedFrom = null;
      return true;
    } catch (error) {
      return this._saveFailure(error?.name || 'STORAGE_ERROR', error);
    }
  }'''
s = s[:clear_start] + new_clear + s[clear_end:]

s = replace_once(s,
"""    if (Array.isArray(o.structs)) this.structs = this.structs.concat(o.structs);\n    this.save();\n    return n;""",
"""    if (Array.isArray(o.structs)) this.structs = this.structs.concat(o.structs);\n    this.dirty = true;\n    this.lastMutationSaved = this.save();\n    return n;""", 'fromJSON persistence status')
p.write_text(s)

# ---------------------------------------------------------------------------
# Existing v2 note keys are migration sources for the new v3 identity.
# ---------------------------------------------------------------------------
p = Path('js/app.js')
s = p.read_text()
s = replace_once(s,
"import { NoteStore, noteKeyFor, legacyNoteKeyFor, EMPTY_NOTES } from './names.js';",
"import { NoteStore, noteKeyFor, legacyV2NoteKeyFor, legacyNoteKeyFor, EMPTY_NOTES } from './names.js';",
'app note import')
old = "new NoteStore(await noteKeyFor(file, info, sliceIndex), [legacyNoteKeyFor(file, info)])"
new = "new NoteStore(await noteKeyFor(file, info, sliceIndex), [await legacyV2NoteKeyFor(file, info, sliceIndex), legacyNoteKeyFor(file, info)])"
s = replace_once(s, old, new, 'openFile v2 migration')
old = "new NoteStore(await noteKeyFor(file, info, index), [legacyNoteKeyFor(file, info)])"
new = "new NoteStore(await noteKeyFor(file, info, index), [await legacyV2NoteKeyFor(file, info, index), legacyNoteKeyFor(file, info)])"
s = replace_once(s, old, new, 'slice switch v2 migration')
p.write_text(s)

# ---------------------------------------------------------------------------
# TypeStore preserves its successful return types but throws a typed error when
# the backing NoteStore cannot persist, so callers cannot mistake failure for success.
# ---------------------------------------------------------------------------
p = Path('js/types-legacy.js')
s = p.read_text()
s = replace_once(s,
"""  constructor(notes) {\n    this.notes = notes || null;\n    this.structs = notes && Array.isArray(notes.structs) ? notes.structs : [];\n  }""",
"""  constructor(notes) {\n    this.notes = notes || null;\n    this.structs = notes && Array.isArray(notes.structs) ? notes.structs : [];\n    this.lastPersisted = true;\n  }""", 'TypeStore constructor')
s = replace_once(s,
"""  persist() {\n    if (!this.notes) return;\n    this.notes.structs = this.structs;\n    this.notes.save();\n  }""",
"""  persist() {\n    if (!this.notes) { this.lastPersisted = true; return true; }\n    this.notes.structs = this.structs;\n    this.notes.dirty = true;\n    const ok = this.notes.save();\n    this.lastPersisted = ok;\n    if (!ok) {\n      const error = new Error('TypeStore could not persist the structure change');\n      error.name = 'PersistenceError';\n      error.code = this.notes.lastSaveError?.code || 'STORAGE_ERROR';\n      error.cause = this.notes.lastSaveError || null;\n      throw error;\n    }\n    return true;\n  }""", 'TypeStore persist')
p.write_text(s)

# ---------------------------------------------------------------------------
# UI: only show success after persistence succeeds; failed changes remain dirty
# and direct the user to retry/export from the Notes screen.
# ---------------------------------------------------------------------------
p = Path('js/tools.js')
s = p.read_text()
marker = "export function showRename(app, addr) {"
if 'function notePersistenceFailure' not in s:
    helper = r'''function notePersistenceFailure(app, action = '変更') {
  const code = app.notes?.lastSaveError?.code || 'STORAGE_ERROR';
  alertDialog('保存できませんでした',
    `${action}はこの画面には残っていますが、端末へ保存できていません（${code}）。\n` +
    '「自分で付けた名前とメモ」を開くと保存の再試行と書き出しができます。ページを閉じる前にバックアップしてください。');
}

'''
    s = s.replace(marker, helper + marker, 1)

s = replace_once(s,
"""  sheet.body.append(field(el('span'), 'メモを保存', () => {\n    app.notes.setComment(addr, memo.value);\n    toast('メモを保存しました');\n  }));""",
"""  sheet.body.append(field(el('span'), 'メモを保存', () => {\n    if (!app.notes.setComment(addr, memo.value)) { notePersistenceFailure(app, 'メモ'); return; }\n    toast('メモを保存しました');\n  }));""", 'rename comment UI')

s = replace_once(s,
"""      app.notes.setName(addr, '');\n      app.symbols.rename(addr, '');\n      app.viewer.setSymbols(app.symbols);\n      sheet.close();\n      toast('元の名前に戻しました');""",
"""      const saved = app.notes.setName(addr, '');\n      app.symbols.rename(addr, '');\n      app.viewer.setSymbols(app.symbols);\n      if (!saved) { notePersistenceFailure(app, '名前の削除'); return; }\n      sheet.close();\n      toast('元の名前に戻しました');""", 'rename delete UI')

s = replace_once(s,
"""    app.notes.setName(addr, v);\n    app.symbols.rename(addr, v);\n    app.viewer.setSymbols(app.symbols);\n    app.updateChrome();\n    sheet.close();\n    toast(v ? '「' + v + '」にしました' : '元の名前に戻しました');""",
"""    const saved = app.notes.setName(addr, v);\n    app.symbols.rename(addr, v);\n    app.viewer.setSymbols(app.symbols);\n    app.updateChrome();\n    if (!saved) { notePersistenceFailure(app, '名前'); return; }\n    sheet.close();\n    toast(v ? '「' + v + '」にしました' : '元の名前に戻しました');""", 'rename apply UI')

s = replace_once(s,
"""  sheet.body.append(field(el('span'), '保存', () => {\n    app.notes.setComment(addr, memo.value);\n    sheet.close();\n    toast('保存しました');\n  }));""",
"""  sheet.body.append(field(el('span'), '保存', () => {\n    if (!app.notes.setComment(addr, memo.value)) { notePersistenceFailure(app, 'メモ'); return; }\n    sheet.close();\n    toast('保存しました');\n  }));""", 'comment dialog UI')

s = replace_once(s,
"""    action: () => { app.notes.setType(funcAddr, key, t.name); toast('型を ' + t.name + ' にしました'); onDone(); },""",
"""    action: () => {\n      if (!app.notes.setType(funcAddr, key, t.name)) { notePersistenceFailure(app, '型'); onDone(); return; }\n      toast('型を ' + t.name + ' にしました'); onDone();\n    },""", 'setType UI')
s = replace_once(s,
"""  items.push({ label: '推測にもどす', action: () => { app.notes.setType(funcAddr, key, ''); onDone(); } });""",
"""  items.push({ label: '推測にもどす', action: () => {\n    if (!app.notes.setType(funcAddr, key, '')) notePersistenceFailure(app, '型');\n    onDone();\n  } });""", 'clearType UI')

s = replace_once(s,
"""    const store = new TypeStore(app.notes);\n    const name = 'struct_' + addr.toString(16).toUpperCase();\n    store.adopt(rec, name);\n    toast(name + ' として保存しました');""",
"""    const store = new TypeStore(app.notes);\n    const name = 'struct_' + addr.toString(16).toUpperCase();\n    try {\n      store.adopt(rec, name);\n      toast(name + ' として保存しました');\n    } catch (error) {\n      if (error?.name !== 'PersistenceError') throw error;\n      notePersistenceFailure(app, '構造体');\n    }""", 'adopt struct UI')

s = replace_once(s,
"""          store.setMember(s.name, m.offset, { name: nameIn.value.trim() || m.name });\n          sheet.close();\n          onChange();\n          toast('名前を付けました');""",
"""          try {\n            store.setMember(s.name, m.offset, { name: nameIn.value.trim() || m.name });\n          } catch (error) {\n            if (error?.name !== 'PersistenceError') throw error;\n            onChange(); notePersistenceFailure(app, '構造体'); return;\n          }\n          sheet.close();\n          onChange();\n          toast('名前を付けました');""", 'set struct member UI')

s = replace_once(s,
"""    store.remove(s.name);\n    sheet.close();\n    onChange();\n    toast('削除しました');""",
"""    try { store.remove(s.name); }\n    catch (error) {\n      if (error?.name !== 'PersistenceError') throw error;\n      onChange(); notePersistenceFailure(app, '構造体の削除'); return;\n    }\n    sheet.close();\n    onChange();\n    toast('削除しました');""", 'remove struct UI')

s = replace_once(s,
"""  const render = () => {\n    body.replaceChildren();\n    const names = app.notes.nameEntries();""",
"""  const render = () => {\n    body.replaceChildren();\n    if (app.notes.dirty) {\n      const warning = noteBox('まだ端末へ保存できていない変更があります。ページを閉じる前に再試行するか、下の「書き出す」でバックアップしてください。', 'warn');\n      const retry = el('div', 'chips');\n      retry.append(button('保存を再試行', 'chip', () => {\n        if (app.notes.save()) { toast('保存しました'); render(); }\n        else notePersistenceFailure(app, '変更');\n      }));\n      warning.append(retry);\n      body.append(warning);\n    }\n    const names = app.notes.nameEntries();""", 'dirty retry UI')

s = replace_once(s,
"""          app.notes.clear();\n          app.viewer.setSymbols(app.symbols);\n          render();\n          toast('消しました');""",
"""          const saved = app.notes.clear();\n          app.viewer.setSymbols(app.symbols);\n          render();\n          if (!saved) { notePersistenceFailure(app, '全消去'); return; }\n          toast('消しました');""", 'clear UI')

s = replace_once(s,
"""          sh.close();\n          render();\n          toast(n + ' 件を取り込みました');""",
"""          sh.close();\n          render();\n          if (!app.notes.lastMutationSaved) { notePersistenceFailure(app, '取り込み'); return; }\n          toast(n + ' 件を取り込みました');""", 'import UI')
p.write_text(s)

# Wire the focused regression into the platform test graph without inventing a new suite.
p = Path('package.json')
s = p.read_text()
needle = '"platform:test": "'
if 'node tests/issues-476-478-notes.mjs' not in s:
    at = s.index(needle) + len(needle)
    s = s[:at] + 'node tests/issues-476-478-notes.mjs && ' + s[at:]
p.write_text(s)
