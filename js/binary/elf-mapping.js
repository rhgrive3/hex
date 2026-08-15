export function safeELFNumber(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** Return the file-backed suffix of the PT_LOAD that owns `va`. */
export function mappedELFFileRangeForVa(image, va) {
  const address = BigInt(va);
  for (const segment of image?.segments || []) {
    const start = BigInt(segment.address ?? 0);
    const fileSize = BigInt(segment.fileSize ?? 0);
    if (fileSize <= 0n || address < start || address >= start + fileSize) continue;
    const delta = address - start;
    const fileStart = BigInt(segment.fileOffset ?? 0) + delta;
    const fileEnd = BigInt(segment.fileOffset ?? 0) + fileSize;
    if (fileStart > BigInt(Number.MAX_SAFE_INTEGER) || fileEnd > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return { start:Number(fileStart), end:Number(fileEnd), segment, address };
  }
  return null;
}

/** Require the entire VA span to remain in one file-backed PT_LOAD mapping. */
export function mappedELFFileSpanForVa(image, va, size) {
  const n = typeof size === 'bigint' ? size : BigInt(size);
  if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const range = mappedELFFileRangeForVa(image, va);
  if (!range) return null;
  const bytes = Number(n);
  if (bytes > range.end - range.start) return null;
  return { ...range, spanEnd:range.start + bytes, size:bytes };
}

/**
 * Validate a function extent inside one canonical executable mapping.
 * Sections are preferred when present because they provide the strongest ELF
 * provenance; sectionless images fall back to executable PT_LOAD segments.
 */
export function executableELFRange(image, address, size = 0n, sectionIndex = null) {
  const start = BigInt(address);
  const extent = BigInt(size ?? 0n);
  if (extent < 0n) return null;
  const fits = (owner) => {
    if (!owner?.perms?.execute) return false;
    const lo = BigInt(owner.address ?? 0), hi = lo + BigInt(owner.size ?? 0);
    if (start < lo || start >= hi) return false;
    return extent === 0n || (extent <= hi - start);
  };
  if (Number.isInteger(sectionIndex)) {
    const section = (image.sections || []).find((s) => s.index === sectionIndex) || null;
    if (fits(section)) return section;
    return null;
  }
  const section = (image.sections || []).find(fits) || null;
  if (section) return section;
  return (image.segments || []).find(fits) || null;
}
