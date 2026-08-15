from pathlib import Path


def replace_once(text, old, new, label):
    if new in text:
        return text
    if old not in text:
        raise SystemExit(f'missing patch anchor: {label}')
    return text.replace(old, new, 1)

p = Path('js/types-legacy.js')
s = p.read_text()

# #472: keep 128-bit SIMD values distinct from scalar float/double.
s = replace_once(s,
"""  { name: 'double',  size: 8, float: true,   ja: '8 バイトの小数' },\n  { name: 'bool',    size: 1, ja: '真偽（0 か 1）' },""",
"""  { name: 'double',  size: 8, float: true,   ja: '8 バイトの小数' },\n  { name: 'vector128', size: 16, vector: true, ja: '16 バイトの SIMD / ベクトル値' },\n  { name: 'bool',    size: 1, ja: '真偽（0 か 1）' },""", 'vector128 basic type')
s = replace_once(s,
"""export function typeFromAccess(bytes, { signed = false, float = false, pointer = false } = {}) {\n  if (pointer) return 'void *';\n  if (float) return bytes === 4 ? 'float' : 'double';""",
"""export function typeFromAccess(bytes, { signed = false, float = false, vector = false, pointer = false } = {}) {\n  if (pointer) return 'void *';\n  if (vector || (float && bytes === 16)) return 'vector128';\n  if (float) return bytes === 4 ? 'float' : 'double';""", 'typeFromAccess vector')
s = replace_once(s,
"""  if (/^q\\d+$|^v\\d+/.test(s)) return { bytes: 16, float: true };""",
"""  if (/^q\\d+$|^v\\d+(?:\\.[0-9]+[bhsd])?$/.test(s)) return { bytes: 16, vector: true };""", 'Q/V vector shape')
s = replace_once(s,
"""function newEvidence() { return { bytes: new Map(), signed: 0, unsigned: 0, float: 0, pointer: 0, text: 0, objc: 0, notes: [] }; }""",
"""function newEvidence() { return { bytes: new Map(), signed: 0, unsigned: 0, float: 0, vector: 0, pointer: 0, text: 0, objc: 0, notes: [] }; }""", 'vector evidence')
s = replace_once(s,
"""  if (evi.pointer >= 1) return { type: 'void *', conf: bytes === 8 ? 0.8 : 0.6 };\n  if (evi.float >= 1) return { type: bytes === 4 ? 'float' : 'double', conf: 0.8 };""",
"""  if (evi.pointer >= 1) return { type: 'void *', conf: bytes === 8 ? 0.8 : 0.6 };\n  if (evi.vector >= 1) return { type: 'vector128', conf: bytes === 16 ? 0.88 : 0.7 };\n  if (evi.float >= 1) return { type: bytes === 4 ? 'float' : 'double', conf: 0.8 };""", 'decide vector')
s = replace_once(s,
"""  if (/^q\\d+$|^v\\d+/.test(s)) return { bytes: 16, float: true };""",
"""  if (/^q\\d+$|^v\\d+(?:\\.[0-9]+[bhsd])?$/.test(s)) return { bytes: 16, vector: true };""", 'vector width fallback') if "if (/^q\\d+$|^v\\d+/.test(s))" in s else s

# #471: canonicalize GPR names, inherit aliases only across proven MOV copies,
# and kill identity on every other write / ABI caller-saved clobber.
anchor = """  // 引数レジスタの「同じ値のまま移された先」を追う（x0 → x19 が典型）\n  const alias = new Map();          // reg -> 引数の reg\n  for (const r of argRegs) alias.set(r, r);\n\n  for (const insn of insns) {\n    const base = (insn.mnemonic || '').toLowerCase();\n\n    /* mov でそのまま移されたら、引数の身元を引き継ぐ */\n    if ((base === 'mov' || base === 'fmov') && insn.ops.length >= 2 &&\n        insn.ops[0] && insn.ops[0].k === 'reg' && insn.ops[1] && insn.ops[1].k === 'reg') {\n      const from = 'x' + insn.ops[1].num;\n      const to = 'x' + insn.ops[0].num;\n      if (alias.has(from)) alias.set(to, alias.get(from));\n      else alias.delete(to);\n    }\n"""
replacement = """  // 引数レジスタの「同じ値のまま移された先」を追う（x0 → x19 が典型）\n  const alias = new Map();          // reg -> 引数の reg\n  for (const r of argRegs) alias.set(r, r);\n  const canonicalGpr = (value) => {\n    const text = typeof value === 'string' ? value : value && value.text;\n    const m = /^[wx](\\d+)$/.exec(String(text || '').toLowerCase());\n    return m ? 'x' + Number(m[1]) : null;\n  };\n\n  for (const insn of insns) {\n    const base = (insn.mnemonic || '').toLowerCase();\n    let copyDest = null, copyOwner = null;\n\n    /* Proven GP-register MOV is the only operation that preserves identity. */\n    if (base === 'mov' && insn.ops.length >= 2 &&\n        insn.ops[0] && insn.ops[0].k === 'reg' && insn.ops[1] && insn.ops[1].k === 'reg') {\n      const from = canonicalGpr(insn.ops[1]);\n      copyDest = canonicalGpr(insn.ops[0]);\n      copyOwner = from ? (alias.get(from) || null) : null;\n    }\n\n    const finishAliases = () => {\n      for (const written of insn.writes || []) {\n        const reg = canonicalGpr(written);\n        if (reg) alias.delete(reg);\n      }\n      if (insn.isCall) {\n        // AAPCS64: x0-x18 are caller-saved. x0 in particular becomes a return\n        // value and must never retain the entry-argument identity.\n        for (let i = 0; i <= 18; i++) alias.delete('x' + i);\n      }\n      if (copyDest) {\n        if (copyOwner) alias.set(copyDest, copyOwner);\n        else alias.delete(copyDest);\n      }\n    };\n"""
s = replace_once(s, anchor, replacement, 'alias lifecycle')

s = replace_once(s,
"""        if (wide && wide.float) e.float++;\n        e.notes.push({ row: insn.row, why: (m.kind === 'load' ? '読み出し' : '書き込み') + ' ' + bytes + ' バイト' });""",
"""        if (wide && wide.vector) e.vector++;\n        else if (wide && wide.float) e.float++;\n        e.notes.push({ row: insn.row, why: (m.kind === 'load' ? '読み出し' : '書き込み') + ' ' + bytes + ' バイト' });""", 'memory vector evidence')
s = replace_once(s,
"""      }\n      continue;\n    }\n\n    /* 小数の命令に出てきたら小数 */""",
"""      }\n      finishAliases();\n      continue;\n    }\n\n    /* 小数の命令に出てきたら小数 */""", 'memory alias kill')
s = replace_once(s,
"""      }\n    }\n  }\n\n  /* 戻り値: 最後に x0 / w0 / d0 に何を入れて帰るか */""",
"""      }\n    }\n\n    finishAliases();\n  }\n\n  /* 戻り値: 最後に x0 / w0 / d0 に何を入れて帰るか */""", 'generic alias kill')
s = replace_once(s,
"""      if (w) { noteSize(retEvi, w.bytes); if (w.float) retEvi.float++; }""",
"""      if (w) {\n        noteSize(retEvi, w.bytes);\n        if (w.vector) retEvi.vector++;\n        else if (w.float) retEvi.float++;\n      }""", 'return vector evidence')
p.write_text(s)

p = Path('package.json')
s = p.read_text()
needle = '\"decompiler:test\": \"'
if 'node tests/issues-471-472-legacy-types.mjs' not in s:
    at = s.index(needle) + len(needle)
    s = s[:at] + 'node tests/issues-471-472-legacy-types.mjs && ' + s[at:]
p.write_text(s)
