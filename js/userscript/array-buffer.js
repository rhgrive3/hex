export function toExactArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    const out = new Uint8Array(value.byteLength);
    out.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return out.buffer;
  }
  throw new TypeError('Expected an ArrayBuffer or ArrayBufferView.');
}
