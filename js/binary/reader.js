export class BinaryReadError extends Error {
  constructor(message, offset = null) {
    super(offset == null ? message : `${message} @ 0x${Number(offset).toString(16)}`);
    this.name = 'BinaryReadError';
    this.offset = offset;
  }
}

export class ByteView {
  constructor(input, { littleEndian = true, base = 0 } = {}) {
    if (input instanceof Uint8Array) this.bytes = input;
    else if (input instanceof ArrayBuffer) this.bytes = new Uint8Array(input);
    else if (ArrayBuffer.isView(input)) this.bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    else throw new TypeError('ByteView expects Uint8Array, ArrayBuffer, or ArrayBufferView');
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.littleEndian = !!littleEndian;
    this.base = Number(base) || 0;
  }

  get length() { return this.bytes.length; }

  endian(littleEndian) {
    return new ByteView(this.bytes, { littleEndian, base: this.base });
  }

  check(offset, size = 1) {
    const o = Number(offset);
    const n = Number(size);
    if (!Number.isSafeInteger(o) || !Number.isSafeInteger(n) || o < 0 || n < 0 || o + n > this.length) {
      throw new BinaryReadError(`read outside file (${n} bytes)`, this.base + Math.max(0, o || 0));
    }
    return o;
  }

  u8(offset) { return this.view.getUint8(this.check(offset, 1)); }
  i8(offset) { return this.view.getInt8(this.check(offset, 1)); }
  u16(offset, le = this.littleEndian) { return this.view.getUint16(this.check(offset, 2), le); }
  i16(offset, le = this.littleEndian) { return this.view.getInt16(this.check(offset, 2), le); }
  u32(offset, le = this.littleEndian) { return this.view.getUint32(this.check(offset, 4), le); }
  i32(offset, le = this.littleEndian) { return this.view.getInt32(this.check(offset, 4), le); }
  u64(offset, le = this.littleEndian) { return this.view.getBigUint64(this.check(offset, 8), le); }
  i64(offset, le = this.littleEndian) { return this.view.getBigInt64(this.check(offset, 8), le); }

  slice(offset, size) {
    const o = this.check(offset, size);
    return this.bytes.subarray(o, o + Number(size));
  }

  subview(offset, size = this.length - Number(offset), opts = {}) {
    const o = this.check(offset, size);
    return new ByteView(this.bytes.subarray(o, o + Number(size)), {
      littleEndian: opts.littleEndian ?? this.littleEndian,
      base: this.base + o,
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
    let p = o;
    while (p < end && this.bytes[p] !== 0) p++;
    const raw = this.bytes.subarray(o, p);
    try { return new TextDecoder('utf-8', { fatal: false }).decode(raw); }
    catch {
      let out = '';
      for (const c of raw) out += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : '\uFFFD';
      return out;
    }
  }

  uleb(offset, maxBytes = 10) {
    let p = this.check(offset, 0);
    let value = 0n;
    let shift = 0n;
    for (let i = 0; i < maxBytes; i++, p++) {
      this.check(p, 1);
      const b = this.bytes[p];
      value |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return { value, next: p + 1, bytes: p + 1 - Number(offset) };
      shift += 7n;
    }
    throw new BinaryReadError('ULEB128 is too long', this.base + Number(offset));
  }

  sleb(offset, maxBytes = 10) {
    let p = this.check(offset, 0);
    let value = 0n;
    let shift = 0n;
    let b = 0;
    for (let i = 0; i < maxBytes; i++, p++) {
      this.check(p, 1);
      b = this.bytes[p];
      value |= BigInt(b & 0x7f) << shift;
      shift += 7n;
      if ((b & 0x80) === 0) {
        if (shift < 64n && (b & 0x40)) value |= (-1n) << shift;
        return { value, next: p + 1, bytes: p + 1 - Number(offset) };
      }
    }
    throw new BinaryReadError('SLEB128 is too long', this.base + Number(offset));
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
