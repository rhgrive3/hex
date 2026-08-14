function printableAscii(c) {
  return c === 9 || (c >= 0x20 && c <= 0x7e);
}

export function scanStrings(image, opts = {}) {
  const min = Math.max(2, opts.minLength || 4);
  const max = Math.max(min, opts.maxLength || 4096);
  const includeUtf16 = opts.utf16 !== false;
  const includeExecutable = !!opts.includeExecutable;
  const ranges = [];
  if (image.sections.length) {
    for (const s of image.sections) {
      if (!s.fileSize) continue;
      if (!includeExecutable && s.perms && s.perms.execute) continue;
      ranges.push({ start: Number(s.fileOffset), size: Number(s.fileSize), section: s.name });
    }
  } else ranges.push({ start: 0, size: image.bytes.length, section: null });

  const out = [];
  const seen = new Set();
  for (const range of ranges) {
    const start = Math.max(0, range.start);
    const end = Math.min(image.bytes.length, start + Math.max(0, range.size));
    for (let p = start; p < end;) {
      if (!printableAscii(image.bytes[p])) { p++; continue; }
      const s = p;
      let q = p;
      while (q < end && q - s < max && printableAscii(image.bytes[q])) q++;
      if (q - s >= min) emit(image, out, seen, s, q - s, 'utf8', range.section);
      p = Math.max(q + 1, p + 1);
    }
    if (!includeUtf16) continue;
    for (let p = start; p + 1 < end;) {
      if (!printableAscii(image.bytes[p]) || image.bytes[p + 1] !== 0) { p++; continue; }
      const s = p;
      let q = p;
      let chars = 0;
      while (q + 1 < end && chars < max && printableAscii(image.bytes[q]) && image.bytes[q + 1] === 0) {
        chars++; q += 2;
      }
      if (chars >= min) emit(image, out, seen, s, q - s, 'utf16le', range.section);
      p = Math.max(q + 2, p + 1);
    }
  }
  return out;
}

function emit(image, out, seen, fileOffset, byteLength, encoding, section) {
  const key = `${fileOffset}:${encoding}`;
  if (seen.has(key)) return;
  seen.add(key);
  const raw = image.bytes.subarray(fileOffset, fileOffset + byteLength);
  let text;
  try { text = new TextDecoder(encoding === 'utf16le' ? 'utf-16le' : 'utf-8').decode(raw); }
  catch { text = String.fromCharCode(...raw.filter((_, i) => encoding !== 'utf16le' || (i & 1) === 0)); }
  out.push({
    text,
    encoding,
    fileOffset: BigInt(fileOffset),
    address: image.offsetToAddress(BigInt(fileOffset)),
    byteLength,
    section,
  });
}
