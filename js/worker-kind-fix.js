'use strict';

/*
 * Keep ProgramIndex's public instruction-kind surface aligned with the
 * independent Capstone oracle without disturbing the scanner's specialized
 * literal-reference route.  These predicates are encoding-exact for the
 * mismatch classes observed on the pinned BattleCats/TsumTsum/YWP fixtures.
 */
const __kindBaseClassify = Words.classifyWord;
const __kindBaseDecode = Words.decodeWord;
const __kindBaseScanProgram = scanProgram;

function __crossBinaryKind(w) {
  w >>>= 0;

  // UDF #0 is the architectural all-zero instruction, not padding.
  if (w === 0) return Words.KIND.TRAP;

  // BICS <W|X>ZR, ...: logical shifted-register with N=1.  TST has N=0.
  if (((w & 0x7f20001f) >>> 0) === 0x6a20001f) return Words.KIND.LOGIC;

  // EXTR and its ROR alias, both 32- and 64-bit forms.
  if (((w & 0x7f800000) >>> 0) === 0x13800000) return Words.KIND.SHIFT;

  // Fixed-point SCVTF/UCVTF/FCVTZS/FCVTZU. bits[15:10] carry fbits,
  // so they must not be part of the opcode mask.
  if (((w & 0x5f200000) >>> 0) === 0x1e000000) return Words.KIND.FCONV;

  // SVE predicated integer ADD (all element widths/predicates/registers).
  if (((w & 0xff3fe000) >>> 0) === 0x04000000) return Words.KIND.ARITH;

  return __kindBaseClassify(w);
}

Words.classifyWord = __crossBinaryKind;

/* decodeWord closes over the original classifier, so mirror the corrected
 * public kind here as well.  Specialized payload decoding remains untouched. */
Words.decodeWord = function decodeWordWithCanonicalKind(w, pc) {
  const out = __kindBaseDecode(w, pc);
  const kind = __crossBinaryKind(w);
  if (kind !== out.kind) {
    out.kind = kind;
    out.kindName = Words.KIND_NAME[kind] || 'OTHER';
  }
  return out;
};

/* LDR-literal is intentionally kept as KIND.LITERAL while scanProgram builds
 * exact PC-relative refs.  Once that routing work is done, expose it through
 * the semantic ProgramIndex kind as LOAD, matching ordinary LDR semantics. */
scanProgram = async function scanProgramWithCanonicalKinds(args) {
  const result = await __kindBaseScanProgram(args);
  if (!result || result.cancelled || !result.kinds) return result;
  for (let i = 0; i < result.kinds.length; i++) {
    if (result.kinds[i] === Words.KIND.LITERAL) result.kinds[i] = Words.KIND.LOAD;
  }
  return result;
};
