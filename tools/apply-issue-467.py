from pathlib import Path


def once(text, old, new, label):
    if new in text:
        return text
    if old not in text:
        raise SystemExit(f'missing patch anchor: {label}')
    return text.replace(old, new, 1)

p = Path('js/gemini.js')
s = p.read_text()
s = once(s,
"""export function buildGeminiPayload(report, model, question, thinkingLevel) {\n  if (!report || !model) throw new Error('解析対象の関数情報がありません。');\n  const assembly = assemblyText(model);\n  if (!assembly) throw new Error('この関数のARM64命令を取り出せませんでした。');\n\n  return {\n    question: String(question || '').trim(),\n    thinkingLevel: thinkingLevel || 'high',\n    currentFunction: {\n      address: addressText(report.identity && report.identity.startAddr),\n      name: report.identity && report.identity.name ? String(report.identity.name) : null,\n      assembly,\n      pseudocode: pseudocodeText(report),\n    },""",
"""export function buildGeminiPayload(report, model, question, thinkingLevel) {\n  if (!report || !model) throw new Error('解析対象の関数情報がありません。');\n  const assembly = assemblyContext(model);\n  if (!assembly.text) throw new Error('この関数のARM64命令を取り出せませんでした。');\n\n  return {\n    question: String(question || '').trim(),\n    thinkingLevel: thinkingLevel || 'high',\n    currentFunction: {\n      address: addressText(report.identity && report.identity.startAddr),\n      name: report.identity && report.identity.name ? String(report.identity.name) : null,\n      assembly: assembly.text,\n      assemblyMeta: assembly.meta,\n      pseudocode: pseudocodeText(report),\n    },""", 'payload assembly metadata')

s = once(s,
"""function assemblyText(model) {\n  return (model.instructions || []).slice(0, MAX_ASSEMBLY_LINES).map((insn) => {\n    const address = addressText(insn.address);\n    return [address, insn.mnemonic || '', insn.operands || ''].filter(Boolean).join('  ');\n  }).join('\\n');\n}""",
"""function assemblyContext(model) {\n  const all = Array.isArray(model?.instructions) ? model.instructions : [];\n  const rows = all.slice(0, MAX_ASSEMBLY_LINES);\n  const totalInstructions = all.length;\n  const includedInstructions = rows.length;\n  const truncated = totalInstructions > includedInstructions;\n  const startRow = includedInstructions ? (Number.isInteger(rows[0]?.row) ? rows[0].row : 0) : null;\n  const endRow = includedInstructions ? (Number.isInteger(rows[rows.length - 1]?.row) ? rows[rows.length - 1].row : includedInstructions - 1) : null;\n  const rendered = rows.map((insn) => {\n    const address = addressText(insn.address);\n    return [address, insn.mnemonic || '', insn.operands || ''].filter(Boolean).join('  ');\n  }).join('\\n');\n  const marker = truncated\n    ? `// [Hex context incomplete: showing ${includedInstructions} of ${totalInstructions} instructions; trailing instructions omitted]`\n    : '';\n  return {\n    text: marker ? `${marker}\\n${rendered}` : rendered,\n    meta: {\n      totalInstructions, includedInstructions, startRow, endRow, truncated,\n      omittedInstructions: Math.max(0, totalInstructions - includedInstructions),\n      selection: 'head',\n    },\n  };\n}\n\nfunction assemblyText(model) { return assemblyContext(model).text; }""", 'assembly context')
p.write_text(s)

p = Path('worker.js')
s = p.read_text()
s = once(s,
"""If the supplied evidence is insufficient, say what additional function, XREF, memory access, or call-site evidence would be most useful next.\n\nAnswer in the language used by the question.""",
"""If the supplied evidence is insufficient, say what additional function, XREF, memory access, or call-site evidence would be most useful next. If currentFunction.assemblyMeta.truncated is true, the supplied assembly is incomplete: do not state whole-function conclusions as complete, and explicitly account for the omitted range.\n\nAnswer in the language used by the question.""", 'legacy system completeness')
s = once(s,
"""Read-only tools may be requested. Mutations (rename, comment, type, struct field, patch, annotation) must only be suggested as actions for later human-reviewed proposals; never request or claim to apply them. Respect explicit scope. Answer in the user's language. Beginner and analyst styles change presentation only, never analysis depth.""",
"""Read-only tools may be requested. Mutations (rename, comment, type, struct field, patch, annotation) must only be suggested as actions for later human-reviewed proposals; never request or claim to apply them. If any supplied function context declares truncated/incomplete assembly, do not treat the visible instruction subset as the complete function. Respect explicit scope. Answer in the user's language. Beginner and analyst styles change presentation only, never analysis depth.""", 'turn system completeness')
s = once(s,
"""  return {\n    address,\n    name: boundedText(value.name, 500).trim() || null,\n    assembly,\n    pseudocode: boundedText(value.pseudocode, 30000).trim() || null,\n  };""",
"""  const rawMeta = isObject(value.assemblyMeta) ? value.assemblyMeta : {};\n  const nonNegativeInt = (v, fallback = 0) => {\n    const n = Number(v);\n    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;\n  };\n  const totalInstructions = nonNegativeInt(rawMeta.totalInstructions);\n  const includedInstructions = nonNegativeInt(rawMeta.includedInstructions);\n  const startRow = rawMeta.startRow == null ? null : nonNegativeInt(rawMeta.startRow);\n  const endRow = rawMeta.endRow == null ? null : nonNegativeInt(rawMeta.endRow);\n  const truncated = rawMeta.truncated === true || totalInstructions > includedInstructions;\n  return {\n    address,\n    name: boundedText(value.name, 500).trim() || null,\n    assembly,\n    assemblyMeta: {\n      totalInstructions, includedInstructions, startRow, endRow, truncated,\n      omittedInstructions: Math.max(0, nonNegativeInt(rawMeta.omittedInstructions, Math.max(0, totalInstructions - includedInstructions))),\n      selection: boundedText(rawMeta.selection, 40).trim() || 'unknown',\n    },\n    pseudocode: boundedText(value.pseudocode, 30000).trim() || null,\n  };""", 'worker normalize metadata')
p.write_text(s)

p = Path('package.json')
s = p.read_text(); needle = '"ai:test": "'
if 'node tests/issue-467-ai-context.mjs' not in s:
    at = s.index(needle) + len(needle)
    s = s[:at] + 'node tests/issue-467-ai-context.mjs && ' + s[at:]
p.write_text(s)
