from pathlib import Path

p = Path('js/objc-legacy.js')
s = p.read_text()

def one(old, new):
    global s
    n = s.count(old)
    if n != 1:
        raise SystemExit(f'expected one match, got {n}: {old[:80]!r}')
    s = s.replace(old, new, 1)

one("export function sanitizePointer(v, base) {\n  if (v === 0n) return null;", "export function sanitizePointer(v, base, pointerFormat = null) {\n  if (v === 0n) return null;\n  const format = pointerFormat == null ? null : Number(pointerFormat);\n  if (format === 2 || format === 6) {\n    const bind = !!((v >> 63n) & 1n);\n    if (bind) return null;\n    const target = v & 0xfffffffffn;\n    if (format === 6) return base == null ? null : BigInt(base) + target;\n    const high8 = (v >> 36n) & 0xffn;\n    return target | (high8 << 56n);\n  }\n  if (format != null) return null;")

one("async function pointer(get, addr) {\n  const b = await get(addr, PTR);\n  return b ? sanitizePointer(u64(b, 0), get.base) : null;\n}", "function cleanPointer(get, value) { return sanitizePointer(value, get.base, get.pointerFormat); }\n\nasync function pointer(get, addr) {\n  const b = await get(addr, PTR);\n  return b ? cleanPointer(get, u64(b, 0)) : null;\n}")

for old, new in [
    ("sanitizePointer(u64(b, 0), get.base)", "cleanPointer(get, u64(b, 0))"),
    ("sanitizePointer(u64(b, 16), get.base)", "cleanPointer(get, u64(b, 16))"),
    ("sanitizePointer(u64(b, 8), get.base)", "cleanPointer(get, u64(b, 8))"),
    ("sanitizePointer(u64(cls, CLASS_DATA) & ~7n, get.base)", "cleanPointer(get, u64(cls, CLASS_DATA) & ~7n)"),
    ("sanitizePointer(u64(ro, RO_NAME), get.base)", "cleanPointer(get, u64(ro, RO_NAME))"),
    ("sanitizePointer(u64(ro, RO_METHODS), get.base)", "cleanPointer(get, u64(ro, RO_METHODS))"),
    ("sanitizePointer(u64(cls, CLASS_SUPER), get.base)", "cleanPointer(get, u64(cls, CLASS_SUPER))"),
    ("sanitizePointer(u64(ro, RO_IVARS), get.base)", "cleanPointer(get, u64(ro, RO_IVARS))"),
    ("sanitizePointer(u64(ro, RO_PROPS), get.base)", "cleanPointer(get, u64(ro, RO_PROPS))"),
    ("sanitizePointer(u64(cls, CLASS_ISA), get.base)", "cleanPointer(get, u64(cls, CLASS_ISA))"),
]:
    s = s.replace(old, new)

one(" * @param {BigInt} [imageBase] イメージの先頭（__TEXT の vmaddr）。\n *   chained fixups のポインタを組み立てるのに要る。渡されなければ\n *   クラス表の位置から推定する（iOS のアプリは 4 GiB 境界に置かれる）。\n */\nexport async function buildObjcModel(read, classList, onProgress, imageBase) {", " * @param {BigInt} [imageBase] イメージの先頭（__TEXT の vmaddr）。\n *   chained fixups のポインタを組み立てるのに要る。渡されなければ\n *   クラス表の位置から推定する（iOS のアプリは 4 GiB 境界に置かれる）。\n * @param {number} [pointerFormat] dyld chained pointer format (2=PTR_64, 6=PTR_64_OFFSET).\n */\nexport async function buildObjcModel(read, classList, onProgress, imageBase, pointerFormat) {")

one("  get.base = imageBase != null\n    ? BigInt(imageBase)\n    : (classList.vmAddr / 0x100000000n) * 0x100000000n;\n  const total", "  get.base = imageBase != null\n    ? BigInt(imageBase)\n    : (classList.vmAddr / 0x100000000n) * 0x100000000n;\n  get.pointerFormat = pointerFormat ?? classList.pointerFormat ?? classList.pointer_format ?? null;\n  const total")

one("export async function buildObjcNames(read, classList, onProgress) {\n  const model = await buildObjcModel(read, classList, onProgress);", "export async function buildObjcNames(read, classList, onProgress, imageBase, pointerFormat) {\n  const model = await buildObjcModel(read, classList, onProgress, imageBase, pointerFormat);")

p.write_text(s)

# Strengthen the targeted regression so next=0 encoded pointers cannot slip through the plain-VA fallback.
t = Path('tests/issues-799-801-806-807-810.mjs')
ts = t.read_text()
old = """const target = 0x123456789n;\nconst high8 = 0xabn;\nconst encoded = target | (high8 << 36n) | (1n << 51n);\nassert.equal(sanitizePointer(encoded), 0xab00000123456789n);\nconst base = 0x100000000n;\nconst offsetEncoded = 0x12345n | (1n << 51n);\nassert.equal(sanitizePointer(offsetEncoded, base), base + 0x12345n);\nassert.equal(sanitizePointer(encoded | (1n << 63n), base), null);\n"""
new = """const target = 0x123456789n;\nconst high8 = 0xabn;\nconst encodedNextZero = target | (high8 << 36n);\nconst encodedWithNext = encodedNextZero | (0x12n << 51n);\nassert.equal(sanitizePointer(encodedNextZero, null, 2), 0xab00000123456789n);\nassert.equal(sanitizePointer(encodedWithNext, null, 2), 0xab00000123456789n);\nconst base = 0x100000000n;\nconst offsetNextZero = 0x12345n;\nassert.equal(sanitizePointer(offsetNextZero, base, 6), base + 0x12345n);\nassert.equal(sanitizePointer(encodedNextZero | (1n << 63n), base, 2), null);\nassert.equal(sanitizePointer(offsetNextZero, null, 6), null);\nassert.equal(sanitizePointer(encodedNextZero, base, 999), null);\n"""
if ts.count(old) != 1:
    raise SystemExit('test block mismatch')
t.write_text(ts.replace(old, new, 1))
