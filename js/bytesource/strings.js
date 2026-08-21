import { asByteSource } from '../binary/source.js';

function printableAscii(c) {
  return c === 9 || (c >= 0x20 && c <= 0x7e);
}

export async function scanSourceStrings(image, input, opts = {}) {
  const source = asByteSource(input);
  const min = Math.max(2, Number(opts.minLength) || 4);
  const max = Math.max(min, Math.min(64 * 1024, Number(opts.maxLength) || 4096));
  const limit = Math.max(1, Math.min(1_000_000, Number(opts.limit) || 200_000));
  const utf16Encodings = chooseUtf16Encodings(image, opts.utf16);
  const includeExecutable = !!opts.includeExecutable;
  const chunkSize = Math.min(source.maxReadLength, Math.max(64 * 1024, Number(opts.chunkSize) || 256 * 1024));
  const ranges = mappedRanges(image, source.size, includeExecutable);
  const out = [];
  const seen = new Set();
  const overlapBytes = Math.min(chunkSize, max * 2 + 2);

  for (const range of ranges) {
    let offset = range.start;
    let carry = new Uint8Array(0);
    while (offset < range.end && out.length < limit) {
      if (opts.signal?.aborted) return { results: out, cancelled: true, capped: false };
      const remaining = range.end - offset;
      const length = Number(remaining < BigInt(chunkSize) ? remaining : BigInt(chunkSize));
      let block;
      try { block = await source.readExactly(offset, length, { signal: opts.signal }); }
      catch (error) {
        if (opts.signal?.aborted || error?.name === 'AbortError' || error?.code === 'BYTE_SOURCE_CANCELLED') return { results: out, cancelled: true, capped: false };
        throw error;
      }
      const bytes = carry.length ? concat(carry, block) : block;
      const base = offset - BigInt(carry.length);
      scanAscii(image, bytes, base, range, min, max, out, seen, limit);
      for (const encoding of utf16Encodings) {
        if (out.length >= limit) break;
        scanUtf16(image, bytes, base, range, min, max, out, seen, limit, encoding);
      }
      const keep = Math.min(overlapBytes, bytes.length);
      carry = bytes.slice(bytes.length - keep);
      offset += BigInt(block.length);
      opts.onProgress?.({ done: offset - range.start, total: range.end - range.start, strings: out.length, section: range.section });
      if (!block.length) break;
    }
    if (out.length >= limit) break;
  }
  return { results: out, cancelled: false, capped: out.length >= limit };
}

function mappedRanges(image, sourceSize, includeExecutable) {
  const items = image.sections?.length ? image.sections : image.segments || [];
  const ranges = [];
  const dedupe = new Set();
  for (const item of items) {
    const size = BigInt(item.fileSize ?? 0);
    const start = BigInt(item.fileOffset ?? 0);
    if (size <= 0n || start < 0n || start >= sourceSize) continue;
    if (!includeExecutable && item.perms?.execute) continue;
    const bounded = size > sourceSize - start ? sourceSize - start : size;
    if (bounded <= 0n) continue;
    const key = `${start}:${bounded}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    ranges.push({ start, end: start + bounded, section: item.name || null });
  }
  if (!items.length && !ranges.length) ranges.push({ start: 0n, end: sourceSize, section: null });
  ranges.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
  return ranges;
}

function scanAscii(image, bytes, base, range, min, max, out, seen, limit) {
  for (let p = 0; p < bytes.length && out.length < limit;) {
    if (!printableAscii(bytes[p])) { p++; continue; }
    const start = p;
    let q = p;
    while (q < bytes.length && q - start < max && printableAscii(bytes[q])) q++;
    if (q - start >= min) emit(image, bytes, base, start, q - start, 'utf8', range, out, seen);
    p = q < bytes.length && printableAscii(bytes[q]) ? q : Math.max(q + 1, p + 1);
  }
}

function chooseUtf16Encodings(image, option) {
  if (option === false) return [];
  if (option === 'be' || option === 'utf16be' || option === 'utf-16be') return ['utf16be'];
  if (option === 'le' || option === 'utf16le' || option === 'utf-16le') return ['utf16le'];
  if (option === 'both') return ['utf16le', 'utf16be'];
  return [image?.endian === 'big' ? 'utf16be' : 'utf16le'];
}

function scanUtf16(image, bytes, base, range, min, max, out, seen, limit, encoding) {
  const be = encoding === 'utf16be';
  const printableAt = (p) => p + 1 < bytes.length && (be ? bytes[p] === 0 && printableAscii(bytes[p + 1]) : printableAscii(bytes[p]) && bytes[p + 1] === 0);
  for (let p = 0; p + 1 < bytes.length && out.length < limit;) {
    if (!printableAt(p)) { p++; continue; }
    const start = p;
    let q = p;
    let chars = 0;
    while (q + 1 < bytes.length && chars < max && printableAt(q)) { chars++; q += 2; }
    if (chars >= min) emit(image, bytes, base, start, q - start, encoding, range, out, seen);
    p = q + 1 < bytes.length && printableAt(q) ? q : Math.max(q + 2, p + 1);
  }
}

function emit(image, bytes, base, localStart, byteLength, encoding, range, out, seen) {
  const fileOffset = base + BigInt(localStart);
  if (fileOffset < range.start || fileOffset >= range.end) return;
  const key = `${fileOffset}:${encoding}`;
  if (seen.has(key)) return;
  seen.add(key);
  const raw = bytes.subarray(localStart, localStart + byteLength);
  let text;
  try { text = new TextDecoder(encoding === 'utf16le' ? 'utf-16le' : encoding === 'utf16be' ? 'utf-16be' : 'utf-8').decode(raw); }
  catch { text = ''; }
  out.push({ text, encoding, fileOffset, address: image.offsetToAddress(fileOffset), byteLength, section: range.section });
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}
