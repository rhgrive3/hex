const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function nonNegativeOffset(value, label = 'offset') {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new TypeError(`${label} must be non-negative`);
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer or bigint`);
  return BigInt(value);
}

export class BinaryReadError extends Error {
  constructor(message, offset = null) {
    let shown = null;
    if (typeof offset === 'bigint' && offset >= 0n) shown = offset;
    else if (Number.isSafeInteger(offset) && offset >= 0) shown = BigInt(offset);
    super(shown == null ? message : `${message} @ 0x${shown.toString(16)}`);
    this.name = 'BinaryReadError';
    this.offset = offset;
  }
}

export class ByteView {
  constructor(input, { littleEndian = true, base = 0 } = {}) {
    if (input instanceof Uint8Array) this.bytes = input;
    else if (input instanceof ArrayBuffer) this.bytes = new Uint8Array(input);
    else if (ArrayBuffer.isView(input)) this.bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    else if (input?.__binaryByteBacking === true && (typeof input.size === 'bigint' || Number.isSafeInteger(input.length)) && typeof input.subarray === 'function') this.bytes = input;
    else throw new TypeError('ByteView expects bytes or a binary byte backing');
    this.view = this.bytes instanceof Uint8Array ? new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength) : null;
    this.littleEndian = !!littleEndian;
    this.base = nonNegativeOffset(base, 'ByteView base');
    this.lengthBigInt = typeof this.bytes.size === 'bigint' ? this.bytes.size : BigInt(this.bytes.length);
  }

  get length() { return this.lengthBigInt > MAX_SAFE_BIGINT ? Number.MAX_SAFE_INTEGER : Number(this.lengthBigInt); }

  endian(littleEndian) {
    return new ByteView(this.bytes, { littleEndian, base: this.base });
  }

  check(offset, size = 1) {
    const o = Number(offset);
    const n = Number(size);
    const ob = Number.isSafeInteger(o) && o >= 0 ? BigInt(o) : -1n;
    const nb = Number.isSafeInteger(n) && n >= 0 ? BigInt(n) : -1n;
    if (ob < 0n || nb < 0n || ob > this.lengthBigInt || nb > this.lengthBigInt - ob) {
      throw new BinaryReadError(`read outside file (${n} bytes)`, this.base + (ob >= 0n ? ob : 0n));
    }
    return o;
  }

  data(offset, size) {
    const o = this.check(offset, size);
    if (this.view) return { view: this.view, offset: o };
    const bytes = this.bytes.subarray(o, o + size);
    return { view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset: 0 };
  }

  u8(offset) { const x = this.data(offset, 1); return x.view.getUint8(x.offset); }
  i8(offset) { const x = this.data(offset, 1); return x.view.getInt8(x.offset); }
  u16(offset, le = this.littleEndian) { const x = this.data(offset, 2); return x.view.getUint16(x.offset, le); }
  i16(offset, le = this.littleEndian) { const x = this.data(offset, 2); return x.view.getInt16(x.offset, le); }
  u32(offset, le = this.littleEndian) { const x = this.data(offset, 4); return x.view.getUint32(x.offset, le); }
  i32(offset, le = this.littleEndian) { const x = this.data(offset, 4); return x.view.getInt32(x.offset, le); }
  u64(offset, le = this.littleEndian) { const x = this.data(offset, 8); return x.view.getBigUint64(x.offset, le); }
  i64(offset, le = this.littleEndian) { const x = this.data(offset, 8); return x.view.getBigInt64(x.offset, le); }

  slice(offset, size) {
    const o = this.check(offset, size);
    return this.bytes.subarray(o, o + Number(size));
  }

  subview(offset, size = this.length - Number(offset), opts = {}) {
    const o = this.check(offset, size);
    return new ByteView(this.bytes.subarray(o, o + Number(size)), {
      littleEndian: opts.littleEndian ?? this.littleEndian,
      base: this.base + BigInt(o),
    });
  }

  ascii(offset, size, { trimNul = true } = {}) {
    const b = this.slice(offset, size);
    let end = b.length;
    if (trimNul) {
      const z = b.indexOf(0);
      if (z >= 0) end = z;
    }
    let out = '';
    for (let i = 0; i < end; i++) out += String.fromCharCode(b[i]);
    return out;
  }

  cstring(offset, max = 1 << 20) {
    const o = this.check(offset, 0);
    const end = Math.min(this.length, o + Math.max(0, Number(max)));
    let raw;
    if (this.view) {
      const span = this.bytes.subarray(o, end);
      const nul = span.indexOf(0);
      raw = nul < 0 ? span : span.subarray(0, nul);
    } else {
      let p = o;
      while (p < end && this.u8(p) !== 0) p++;
      raw = this.bytes.subarray(o, p);
    }
    try { return new TextDecoder('utf-8', { fatal: false }).decode(raw); }
    catch {
      let out = '';
      for (const c of raw) out += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : '\uFFFD';
      return out;
    }
  }

  _lebEnd(end) {
    if (end == null) return this.length;
    const n = Number(end);
    if (!Number.isSafeInteger(n) || n < 0 || BigInt(n) > this.lengthBigInt)
      throw new BinaryReadError('invalid bounded substream end', this.base);
    return n;
  }

  uleb(offset, maxBytes = 10, end = null) {
    const start = this.check(offset, 0);
    const hardEnd = this._lebEnd(end);
    if (start > hardEnd) throw new BinaryReadError('ULEB128 starts outside bounded substream', this.base + BigInt(start));
    let p = start;
    let value = 0n;
    let shift = 0n;
    for (let i = 0; i < maxBytes; i++, p++) {
      if (p >= hardEnd) throw new BinaryReadError('ULEB128 crosses bounded substream', this.base + BigInt(p));
      this.check(p, 1);
      const b = this.u8(p);
      value |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return { value, next: p + 1, bytes: p + 1 - start };
      shift += 7n;
    }
    throw new BinaryReadError('ULEB128 is too long', this.base + BigInt(start));
  }

  sleb(offset, maxBytes = 10, end = null) {
    const start = this.check(offset, 0);
    const hardEnd = this._lebEnd(end);
    if (start > hardEnd) throw new BinaryReadError('SLEB128 starts outside bounded substream', this.base + BigInt(start));
    let p = start;
    let value = 0n;
    let shift = 0n;
    let b = 0;
    for (let i = 0; i < maxBytes; i++, p++) {
      if (p >= hardEnd) throw new BinaryReadError('SLEB128 crosses bounded substream', this.base + BigInt(p));
      this.check(p, 1);
      b = this.u8(p);
      value |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if ((b & 0x80) === 0) {
        if (b & 0x40) value |= (-1n) << shift;
        return { value, next: p + 1, bytes: p + 1 - start };
      }
    }
    throw new BinaryReadError('SLEB128 is too long', this.base + BigInt(start));
  }
}

export function align(value, alignment) {
  const v = BigInt(value);
  const a = BigInt(alignment);
  if (a <= 0n) return v;
  return (v + a - 1n) / a * a;
}

export function inRange(value, start, size) {
  const v = BigInt(value);
  const s = BigInt(start);
  const n = BigInt(size);
  return n > 0n && v >= s && v < s + n;
}

export function hex(value) {
  if (value == null) return null;
  return '0x' + BigInt(value).toString(16).toUpperCase();
}
