import { functionSeed } from './model.js';

export function parseEhFrameHeader(r, sec, image, bits) {
  if (sec.size < 4n || sec.offset + sec.size > BigInt(r.length)) return;
  let p = Number(sec.offset);
  const end = Number(sec.offset + sec.size);
  const version = r.u8(p++);
  const ehFrameEnc = r.u8(p++);
  const countEnc = r.u8(p++);
  const tableEnc = r.u8(p++);
  if (version !== 1 || tableEnc === 0xff) return;
  const ctx = {
    secAddress: sec.addr,
    secOffset: Number(sec.offset),
    textBase: (image.segments.find((s) => s.perms.execute) || image.segments[0] || { address: 0n }).address,
    image,
    bits,
    functionBase: null,
  };
  try {
    const frame = decodeEhValue(r, p, ehFrameEnc, ctx); p = frame.next;
    const countX = decodeEhValue(r, p, countEnc, ctx); p = countX.next;
    const count = Number(countX.raw);
    if (!Number.isSafeInteger(count) || count < 0 || count > 10_000_000) return;
    let added = 0;
    for (let i = 0; i < count && p < end; i++) {
      const initial = decodeEhValue(r, p, tableEnc, ctx); p = initial.next;
      const fde = decodeEhValue(r, p, tableEnc, ctx); p = fde.next;
      if (initial.value == null || initial.value === 0n) continue;
      const codeSec = image.sectionAt(initial.value);
      if (codeSec && codeSec.perms.execute) {
        image.functions.push(functionSeed(initial.value, { source: 'unwind', confidence: 0.985 }));
        added++;
      }
      void fde;
    }
    image.metadata.ehFrameHeader = { version, ehFrameEnc, countEnc, tableEnc, declaredFunctions: count, recoveredFunctions: added };
    void frame;
  } catch (e) {
    if (e?.code === 'BINARY_SOURCE_RANGE_MISSING') throw e;
    image.warnings.push(`.eh_frame_hdr: ${e.message}`);
  }
}

function decodeEhValue(r, p0, enc, ctx) {
  if (enc === 0xff) return { value: null, raw: 0n, next: p0 };
  const format = enc & 0x0f;
  const application = enc & 0x70;
  const indirect = !!(enc & 0x80);
  const ptrBytes = ctx.bits === 64 ? 8 : 4;
  let p = p0;
  if (application === 0x50) p = Math.ceil(p / ptrBytes) * ptrBytes;
  let raw, next;
  if (format === 0x00) { raw = ctx.bits === 64 ? r.u64(p) : BigInt(r.u32(p)); next = p + ptrBytes; }
  else if (format === 0x01) { const x = r.uleb(p); raw = x.value; next = x.next; }
  else if (format === 0x02) { raw = BigInt(r.u16(p)); next = p + 2; }
  else if (format === 0x03) { raw = BigInt(r.u32(p)); next = p + 4; }
  else if (format === 0x04) { raw = r.u64(p); next = p + 8; }
  else if (format === 0x09) { const x = r.sleb(p); raw = x.value; next = x.next; }
  else if (format === 0x0a) { raw = BigInt(r.i16(p)); next = p + 2; }
  else if (format === 0x0b) { raw = BigInt(r.i32(p)); next = p + 4; }
  else if (format === 0x0c) { raw = r.i64(p); next = p + 8; }
  else throw new Error(`unsupported DW_EH_PE format 0x${format.toString(16)}`);
  let value = raw;
  const fieldAddress = ctx.secAddress + BigInt(p - ctx.secOffset);
  if (application === 0x10) value += fieldAddress;
  else if (application === 0x20) value += ctx.textBase;
  else if (application === 0x30) value += ctx.secAddress;
  else if (application === 0x40) {
    if (ctx.functionBase == null) throw new Error('DW_EH_PE_funcrel requires a function base');
    value += ctx.functionBase;
  }
  else if (application !== 0 && application !== 0x50) throw new Error(`unsupported DW_EH_PE application 0x${application.toString(16)}`);
  if (indirect) {
    const off = ctx.image.addressToOffset(value);
    if (off == null || off + BigInt(ptrBytes) > BigInt(r.length)) throw new Error(`DW_EH_PE_indirect target 0x${value.toString(16)} is not readable`);
    value = ctx.bits === 64 ? r.u64(Number(off)) : BigInt(r.u32(Number(off)));
  }
  return { value, raw, next };
}
