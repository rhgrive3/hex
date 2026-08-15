from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text()


def write(path, text):
    (ROOT / path).write_text(text)


def replace_once(path, old, new):
    text = read(path)
    if old not in text:
        raise RuntimeError(f"pattern not found in {path}: {old[:120]!r}")
    text = text.replace(old, new, 1)
    write(path, text)


def replace_between(path, start, end, replacement, include_end=False):
    text = read(path)
    i = text.find(start)
    if i < 0:
        raise RuntimeError(f"start marker not found in {path}: {start!r}")
    j = text.find(end, i + len(start))
    if j < 0:
        raise RuntimeError(f"end marker not found in {path}: {end!r}")
    tail = j + len(end) if include_end else j
    write(path, text[:i] + replacement + text[tail:])


# #323: objc_setProperty ABI is (self=x0, _cmd=x1, offset=x2, value=x3).
replace_once(
    'js/dataflow-semantic.js',
    "    const offsetReg = read ? 'x2' : 'x3';",
    "    const offsetReg = 'x2';",
)
replace_once(
    'js/dataflow-semantic.js',
    "      store: { row: inst.row, address: inst.address, reg: read ? 'x0' : 'x2' },\n      register: read ? 'x0' : 'x2',",
    "      store: { row: inst.row, address: inst.address, reg: read ? 'x0' : 'x3' },\n      register: read ? 'x0' : 'x3',",
)

# #328: do not cap before scoring. Maintain a bounded top-K after evaluating every hit.
features = read('js/features.js')
marker = 'export function groupByFeature(strings, perFeature = 200) {'
pos = features.find(marker)
if pos < 0:
    raise RuntimeError('groupByFeature marker missing')
new_group = r'''export function groupByFeature(strings, perFeature = 200) {
  const limit = Math.max(0, Math.floor(Number(perFeature) || 0));
  const buckets = new Map();
  for (const f of FEATURES) buckets.set(f.id, []);

  // Evaluate every matching string.  The limit is a retention bound, not an
  // evaluation bound: a late strong hit must be able to evict an early weak hit.
  for (const s of strings || []) {
    const hits = classifyString(s.text);
    for (const h of hits) {
      const list = buckets.get(h.id);
      if (!list || limit <= 0) continue;
      const item = { addr: s.addr, text: s.text, score: strength(s.text, h.weak) };
      if (list.length < limit) {
        list.push(item);
        list.sort((a, b) => b.score - a.score);
      } else if (item.score > list[list.length - 1].score) {
        list[list.length - 1] = item;
        list.sort((a, b) => b.score - a.score);
      }
    }
  }

  const out = [];
  for (const f of FEATURES) {
    const list = buckets.get(f.id);
    if (!list.length) continue;
    list.sort((a, b) => b.score - a.score);
    out.push({ id: f.id, label: pick(f.ja, f.en), items: list });
  }
  out.sort((a, b) => b.items.length - a.items.length);
  return out;
}
'''
write('js/features.js', features[:pos] + new_group)

# #333: a prefix-only cluster is weak inference, never a hard app-code exclusion.
replace_once(
    'js/vendors.js',
    "export function vendorConflicts(goalId, vendor) {\n  if (!vendor) return false;\n  if (!GAME_VALUE_GOALS.has(goalId)) return false;\n  return true;\n}",
    "export function vendorConflicts(goalId, vendor) {\n  if (!vendor) return false;\n  if (!GAME_VALUE_GOALS.has(goalId)) return false;\n  if (vendor.via === 'cluster' || vendor.confidence === 'low') return false;\n  return true;\n}",
)

# #334: collect all name matches, then retain the strongest 400 before ranking.
rank = read('js/rank.js')
start = "  const matcher = combinedMatcher(goal);\n"
end = "\n  /* ── 3. 呼び出し関係"
i = rank.find(start)
j = rank.find(end, i)
if i < 0 or j < 0:
    raise RuntimeError('rank name-scan markers missing')
new_rank_block = r'''  const matcher = combinedMatcher(goal);
  if (matcher && symbols && symbols.symbolCount) {
    const lo = region ? region.vmAddr : null;
    const hi = region ? region.vmAddr + region.size : null;
    const matches = [];
    for (let i = 0; i < symbols.addrs.length; i++) {
      const a = symbols.addrs[i];
      if (lo != null && (a < lo || a >= hi)) continue;
      const name = symbols.names[i];
      if (!name || !matcher.test(name)) continue;
      const m = matchName(goal, name);
      if (!m) continue;
      matches.push({ a, name, m });
    }
    matches.sort((a, b) => b.m.score - a.m.score || String(a.name).localeCompare(String(b.name)));
    if (matches.length > 400) notes.push('name-matches-capped');
    for (const { a, name, m } of matches.slice(0, 400)) {
      const start = symbols.functionCount ? (symbols.isFunctionStart(a) ? a : null) : a;
      const c = candidate(start != null ? start : a, a);
      if (!c) continue;
      c.name = c.name || name;
      addReason(c, REASON.NAME, POINTS[REASON.NAME] * m.score, { name, term: m.term });
    }
  }
'''
write('js/rank.js', rank[:i] + new_rank_block + rank[j:])

# #336: confidence is not provenance. Never infer VERIFIED from confidence alone.
replace_once(
    'js/ai/render/normalize.js',
    "  if (n != null) {\n    if (n >= 0.95) return STATUS.VERIFIED;\n    if (n >= 0.7) return STATUS.SUPPORTED;\n    if (n > 0) return STATUS.HYPOTHESIS;\n  }",
    "  if (n != null) {\n    if (n >= 0.7) return STATUS.SUPPORTED;\n    if (n > 0) return STATUS.HYPOTHESIS;\n  }",
)

# #337: dangling evidence ids must remain unresolved and must not become fake support.
replace_once(
    'js/ai/render/normalize.js',
    "    support: support.map((id) => evidenceById.get(id) || { id, title: id, status: STATUS.SUPPORTED }),\n    contradictions: contradictions.map((id) => evidenceById.get(id) || { id, title: id, status: STATUS.CONTRADICTED }),\n    missing: (Array.isArray(raw.missingEvidence) ? raw.missingEvidence : []).map((item) => text(item, 200)).slice(0, 8),",
    "    support: support.map((id) => evidenceById.get(id) || { id, title: id, status: STATUS.UNKNOWN, unresolved: true }).filter((item) => !item.unresolved),\n    contradictions: contradictions.map((id) => evidenceById.get(id) || { id, title: id, status: STATUS.UNKNOWN, unresolved: true }).filter((item) => !item.unresolved),\n    unresolvedEvidenceIds: [...support, ...contradictions].filter((id) => !evidenceById.has(id)),\n    missing: (Array.isArray(raw.missingEvidence) ? raw.missingEvidence : []).map((item) => text(item, 200)).slice(0, 8),",
)

# #345: identities that discard an operand are valid only when that operand is pure.
for old, new in [
    ("binRule('mul-zero-right', 'canonical', 'mul', (n) => isConst(n.right, 0) ? {} : null, (n) => c(0, n)),",
     "binRule('mul-zero-right', 'canonical', 'mul', (n) => isConst(n.right, 0) && isPure(n.left) ? {} : null, (n) => c(0, n)),"),
    ("binRule('mul-zero-left', 'canonical', 'mul', (n) => isConst(n.left, 0) ? {} : null, (n) => c(0, n)),",
     "binRule('mul-zero-left', 'canonical', 'mul', (n) => isConst(n.left, 0) && isPure(n.right) ? {} : null, (n) => c(0, n)),"),
    ("binRule('and-zero-right', 'canonical', 'and', (n) => isConst(n.right, 0) ? {} : null, (n) => c(0, n)),",
     "binRule('and-zero-right', 'canonical', 'and', (n) => isConst(n.right, 0) && isPure(n.left) ? {} : null, (n) => c(0, n)),"),
    ("binRule('and-zero-left', 'canonical', 'and', (n) => isConst(n.left, 0) ? {} : null, (n) => c(0, n)),",
     "binRule('and-zero-left', 'canonical', 'and', (n) => isConst(n.left, 0) && isPure(n.right) ? {} : null, (n) => c(0, n)),"),
    ("binRule('umod-one', 'canonical', 'umod', (n) => isConst(n.right, 1) ? {} : null, (n) => c(0, n)),",
     "binRule('umod-one', 'canonical', 'umod', (n) => isConst(n.right, 1) && isPure(n.left) ? {} : null, (n) => c(0, n)),"),
    ("binRule('smod-one', 'canonical', 'smod', (n) => isConst(n.right, 1) ? {} : null, (n) => c(0, n)),",
     "binRule('smod-one', 'canonical', 'smod', (n) => isConst(n.right, 1) && isPure(n.left) ? {} : null, (n) => c(0, n)),"),
    ("match: (n) => n?.kind === 'select' && sameExpr(n.whenTrue, n.whenFalse) && mayDuplicate(n.whenTrue) ? {} : null,",
     "match: (n) => n?.kind === 'select' && sameExpr(n.whenTrue, n.whenFalse) && isPure(n.condition) && mayDuplicate(n.whenTrue) ? {} : null,"),
]:
    replace_once('js/decompiler/rewrite/rules.js', old, new)

# #348: let the AST printer own postfix precedence for field/index addresses.
replace_once(
    'js/decompiler/pipeline-core.js',
    "    return { kind: 'field', key: loc.key, offset: off, base, name, text: `${printExpression(base)}->${name}` };",
    "    const access = expr.field(base, name, off, Number(loc.size || inst?.size || 64), origin(inst));\n    return { kind: 'field', key: loc.key, offset: off, base, name, expression: access, text: printExpression(access) };",
)
replace_once(
    'js/decompiler/pipeline-core.js',
    "    if (Number(addr.size || inst?.size || 0) === scale) return { kind: 'index', key: loc.key, base, index, scale, text: `${printExpression(base)}[${printExpression(index)}]` };",
    "    if (Number(addr.size || inst?.size || 0) === scale) {\n      const access = expr.index(base, index, scale, Number(addr.size || inst?.size || 64), origin(inst));\n      return { kind: 'index', key: loc.key, base, index, scale, expression: access, text: printExpression(access) };\n    }",
)

# #338: validate ELF PT_LOAD invariants with overflow-safe BigInt arithmetic.
elf_old = r'''    out.push(ph);
    if (ph.type === PT_LOAD) {
      image.addSegment({
        name: `LOAD${i}`, address: ph.vaddr, size: ph.memsz, fileOffset: ph.offset, fileSize: ph.filesz,
        perms: { read: !!(ph.flags & 4), write: !!(ph.flags & 2), execute: !!(ph.flags & 1) }, flags: ph.flags, source: 'PT_LOAD',
      });
    }'''
elf_new = r'''    if (ph.type === PT_LOAD) {
      const fileLength = BigInt(r.length);
      const invalidSize = ph.filesz > ph.memsz;
      const invalidRange = ph.offset > fileLength || ph.filesz > fileLength - ph.offset;
      if (invalidSize || invalidRange) {
        image.warnings.push(`invalid ELF PT_LOAD ${i}: ${invalidSize ? 'p_filesz > p_memsz' : 'file range exceeds input'}`);
        continue;
      }
    }
    out.push(ph);
    if (ph.type === PT_LOAD) {
      image.addSegment({
        name: `LOAD${i}`, address: ph.vaddr, size: ph.memsz, fileOffset: ph.offset, fileSize: ph.filesz,
        perms: { read: !!(ph.flags & 4), write: !!(ph.flags & 2), execute: !!(ph.flags & 1) }, flags: ph.flags, source: 'PT_LOAD',
      });
    }'''
replace_once('js/binary/elf.js', elf_old, elf_new)

# #340: Mach-O segment/section VM and file-backed ranges must stay within parents/input.
# Inject common validator and call it before adding each segment/section.
macho = read('js/binary/macho.js')
insert_at = macho.find('function parseSegment64(')
if insert_at < 0:
    raise RuntimeError('parseSegment64 marker missing')
validator = r'''function validateMappedRange(label, address, size, fileOffset, fileSize, image) {
  const inputSize = BigInt(image.bytes?.length ?? image.fileSize ?? 0);
  if (fileSize > size) throw new Error(`${label} file size exceeds VM size`);
  if (fileOffset > inputSize || fileSize > inputSize - fileOffset) throw new Error(`${label} file range exceeds input`);
  return { vmEnd: address + size, fileEnd: fileOffset + fileSize };
}

function validateSectionRange(label, saddr, ssize, fileOffset, fileSize, seg, image, zeroFill) {
  if (saddr < seg.address || saddr > seg.address + seg.size || ssize > seg.address + seg.size - saddr) throw new Error(`${label} VM range escapes parent segment`);
  if (!zeroFill) {
    if (fileOffset < seg.fileOffset || fileOffset > seg.fileOffset + seg.fileSize || fileSize > seg.fileOffset + seg.fileSize - fileOffset) throw new Error(`${label} file range escapes parent segment`);
    validateMappedRange(label, saddr, ssize, fileOffset, fileSize, image);
  }
}

'''
macho = macho[:insert_at] + validator + macho[insert_at:]
write('js/binary/macho.js', macho)
replace_once('js/binary/macho.js',
    "  const flags = r.u32(p + 68);\n  const seg = image.addSegment({ name, address, size, fileOffset, fileSize, perms: vmPerms(initprot), flags, source: 'LC_SEGMENT_64' });",
    "  const flags = r.u32(p + 68);\n  validateMappedRange(`segment ${name}`, address, size, fileOffset, fileSize, image);\n  const seg = image.addSegment({ name, address, size, fileOffset, fileSize, perms: vmPerms(initprot), flags, source: 'LC_SEGMENT_64' });")
replace_once('js/binary/macho.js',
    "    const zeroFill = (sflags & 0xff) === 1 || (sflags & 0xff) === 0x0c || (sflags & 0xff) === 0x12;\n    image.addSection({ name: sectname, segment: segname, address: saddr, size: ssize, fileOffset: BigInt(offset), fileSize: zeroFill ? 0n : ssize, perms: vmPerms(initprot), flags: sflags, index: image.sections.length + 1 });",
    "    const zeroFill = (sflags & 0xff) === 1 || (sflags & 0xff) === 0x0c || (sflags & 0xff) === 0x12;\n    const sectionFileOffset = BigInt(offset), sectionFileSize = zeroFill ? 0n : ssize;\n    validateSectionRange(`section ${sectname}`, saddr, ssize, sectionFileOffset, sectionFileSize, seg, image, zeroFill);\n    image.addSection({ name: sectname, segment: segname, address: saddr, size: ssize, fileOffset: sectionFileOffset, fileSize: sectionFileSize, perms: vmPerms(initprot), flags: sflags, index: image.sections.length + 1 });")
replace_once('js/binary/macho.js',
    "  const flags = r.u32(p + 52);\n  const seg = image.addSegment({ name, address, size, fileOffset, fileSize, perms: vmPerms(initprot), flags, source: 'LC_SEGMENT' });",
    "  const flags = r.u32(p + 52);\n  validateMappedRange(`segment ${name}`, address, size, fileOffset, fileSize, image);\n  const seg = image.addSegment({ name, address, size, fileOffset, fileSize, perms: vmPerms(initprot), flags, source: 'LC_SEGMENT' });")
# Same section text occurs again in parseSegment32 after the first replacement consumed the 64-bit copy.
replace_once('js/binary/macho.js',
    "    const zeroFill = (sflags & 0xff) === 1 || (sflags & 0xff) === 0x0c || (sflags & 0xff) === 0x12;\n    image.addSection({ name: sectname, segment: segname, address: saddr, size: ssize, fileOffset: BigInt(offset), fileSize: zeroFill ? 0n : ssize, perms: vmPerms(initprot), flags: sflags, index: image.sections.length + 1 });",
    "    const zeroFill = (sflags & 0xff) === 1 || (sflags & 0xff) === 0x0c || (sflags & 0xff) === 0x12;\n    const sectionFileOffset = BigInt(offset), sectionFileSize = zeroFill ? 0n : ssize;\n    validateSectionRange(`section ${sectname}`, saddr, ssize, sectionFileOffset, sectionFileSize, seg, image, zeroFill);\n    image.addSection({ name: sectname, segment: segname, address: saddr, size: ssize, fileOffset: sectionFileOffset, fileSize: sectionFileSize, perms: vmPerms(initprot), flags: sflags, index: image.sections.length + 1 });")

# #341: accept LC_FUNCTION_STARTS entries only when mapped executable and aligned.
old_fs = r'''function parseFunctionStarts(r, dc, image) {
  if (!dc.size || dc.offset + dc.size > r.length) return;
  let p = dc.offset;
  const end = dc.offset + dc.size;
  let addr = image.imageBase;
  while (p < end) {
    const x = r.uleb(p);
    p = x.next;
    if (x.value === 0n) break;
    addr += x.value;
    image.functions.push(functionSeed(addr, { source: 'function_starts', confidence: 0.995 }));
  }
}'''
new_fs = r'''function parseFunctionStarts(r, dc, image) {
  if (!dc.size || dc.offset > r.length || dc.size > r.length - dc.offset) return;
  let p = dc.offset;
  const end = dc.offset + dc.size;
  let addr = image.imageBase;
  const alignment = image.arch === 'arm64' ? 4n : image.arch === 'arm' ? 2n : 1n;
  while (p < end) {
    const x = r.uleb(p);
    p = x.next;
    if (x.value === 0n) break;
    const next = addr + x.value;
    if (next < addr) { image.warnings.push('LC_FUNCTION_STARTS address overflow'); break; }
    addr = next;
    const seg = image.segmentAt(addr);
    if (!seg || !seg.perms.execute || (alignment > 1n && addr % alignment !== 0n)) {
      image.warnings.push(`invalid LC_FUNCTION_STARTS entry 0x${addr.toString(16)}`);
      continue;
    }
    image.functions.push(functionSeed(addr, { source: 'function_starts', confidence: 0.995 }));
  }
}'''
replace_once('js/binary/macho.js', old_fs, new_fs)

print('initial issue batch codemod applied')
