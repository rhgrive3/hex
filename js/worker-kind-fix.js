'use strict';

/*
 * ProgramIndex kind corrections for instruction encodings that the fast
 * scanner intentionally does not fully decode. Apply them only after the
 * scanner has finished so xref/provenance/control-flow routing keeps the
 * existing hardened classification surface.
 */
const __kindBaseScanProgram = scanProgram;

function __crossBinaryExactKind(w) {
  w >>>= 0;

  // UDF #0 is the architectural all-zero instruction, not padding.
  if (w === 0) return Words.KIND.TRAP;

  // BICS <W|X>ZR, ...: logical shifted-register with N=1. TST has N=0.
  if (((w & 0x7f20001f) >>> 0) === 0x6a20001f) return Words.KIND.LOGIC;

  // EXTR and its ROR alias, both 32- and 64-bit forms.
  if (((w & 0x7f800000) >>> 0) === 0x13800000) return Words.KIND.SHIFT;

  // Fixed-point SCVTF/UCVTF/FCVTZS/FCVTZU. bits[15:10] carry fbits.
  if (((w & 0x5f200000) >>> 0) === 0x1e000000) return Words.KIND.FCONV;

  // SVE predicated integer ADD (all element widths/predicates/registers).
  if (((w & 0xff3fe000) >>> 0) === 0x04000000) return Words.KIND.ARITH;

  return null;
}

scanProgram = async function scanProgramWithCanonicalKinds(args) {
  const result = await __kindBaseScanProgram(args);
  if (!result || result.cancelled || !result.kinds) return result;

  const region = regions.get(args.regionId);
  if (!region) return result;

  const count = Math.min(
    result.kinds.length,
    Number(result.kindsCovered ?? result.kinds.length) || 0,
    Math.floor(Number(region.size) / 4),
  );
  if (!count) return result;

  // Keep literal-load routing internal to the scanner, but expose the
  // instruction semantically as LOAD in ProgramIndex.
  for (let i = 0; i < count; i++) {
    if (result.kinds[i] === Words.KIND.LITERAL) result.kinds[i] = Words.KIND.LOAD;
  }

  // One bounded sequential pass is cheaper and safer than re-running any
  // disassembler. Only encoding-exact matches above can change a kind.
  const CHUNK = 1024 * 1024;
  const byteLimit = count * 4;
  for (let pos = 0; pos < byteLimit; pos += CHUNK) {
    if (cancelled(args.requestId)) return { cancelled:true, __transfer:[] };
    const want = Math.min(CHUNK, byteLimit - pos);
    const raw = await readRange(region.fileOffset + BigInt(pos), want);
    const words = Math.floor(raw.length / 4);
    if (!words) break;
    const dv = new DataView(raw.buffer, raw.byteOffset, words * 4);
    const base = pos / 4;
    for (let i = 0; i < words; i++) {
      const exact = __crossBinaryExactKind(dv.getUint32(i * 4, true));
      if (exact != null) result.kinds[base + i] = exact;
    }
    await yieldToQueue();
    if (raw.length < want) break;
  }

  return result;
};
