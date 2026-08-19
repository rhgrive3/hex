/* Exact late lowering for ARM64 instructions that the legacy/semantic
 * decompilers still preserve as raw __asm. This is deliberately mnemonic-
 * scoped: unknown instructions stay raw assembly rather than being hidden. */

function renderedText(lines) {
  return (lines || []).map((line) => `${'    '.repeat(Math.max(0, line.indent || 0))}${line.text || ''}`).join('\n');
}

function splitOperands(text) {
  return String(text || '').split(',').map((x) => x.trim()).filter(Boolean);
}

function parseImm(text) {
  const raw = String(text || '').trim().replace(/^#/, '');
  if (!/^-?(?:0x[0-9a-f]+|\d+)$/i.test(raw)) return null;
  const value = Number.parseInt(raw, 0);
  return Number.isSafeInteger(value) ? value : null;
}

function asmPayload(text) {
  const match = /^\s*__asm\s*\(\s*(["'])(.*?)\1\s*\)\s*;?\s*$/.exec(String(text || ''));
  return match ? match[2].trim() : null;
}

function lowerOne(payload) {
  const space = payload.indexOf(' ');
  const mnemonic = (space < 0 ? payload : payload.slice(0, space)).toLowerCase();
  const operands = splitOperands(space < 0 ? '' : payload.slice(space + 1));

  // REV <Wd|Xd>, <Wn|Xn>: architectural byte reversal of the complete
  // 32/64-bit general-purpose register value.
  if (mnemonic === 'rev' && operands.length === 2 && /^[wx]\d+$/i.test(operands[0]) && /^[wx]\d+$/i.test(operands[1])) {
    const bits = operands[0][0].toLowerCase() === 'w' ? 32 : 64;
    return `${operands[0]} = __builtin_bswap${bits}(${operands[1]});`;
  }

  // FCVTAS: floating point -> signed integer, FPCR-independent round to
  // nearest with halfway cases away from zero. Keep the rounding contract in
  // the pseudo intrinsic name instead of mis-rendering this as a C cast.
  if (mnemonic === 'fcvtas' && operands.length === 2 && /^[wx]\d+$/i.test(operands[0]) && /^[sd]\d+$/i.test(operands[1])) {
    const bits = operands[0][0].toLowerCase() === 'w' ? 32 : 64;
    return `${operands[0]} = __a64_round_ties_away_s${bits}(${operands[1]});`;
  }

  // FCSEL <Sd|Dd>, <Sn|Dn>, <Sm|Dm>, <cond> chooses one FP source from the
  // current NZCV condition. The helper names the architectural predicate; it
  // is not an opaque assembly escape hatch.
  if (mnemonic === 'fcsel' && operands.length === 4 && /^[sd]\d+$/i.test(operands[0]) && /^[sd]\d+$/i.test(operands[1]) && /^[sd]\d+$/i.test(operands[2]) && /^[a-z]{2}$/i.test(operands[3])) {
    return `${operands[0]} = __a64_cond_${operands[3].toLowerCase()}() ? ${operands[1]} : ${operands[2]};`;
  }

  // FCCMP conditionally performs an FP compare; when the predicate is false,
  // NZCV is replaced by the encoded immediate. Represent the flag effect
  // explicitly because dropping it would change subsequent FCSEL/branches.
  if (mnemonic === 'fccmp' && operands.length === 4 && /^[sd]\d+$/i.test(operands[0]) && /^[sd]\d+$/i.test(operands[1]) && /^[a-z]{2}$/i.test(operands[3])) {
    const nzcv = parseImm(operands[2]);
    if (nzcv != null && nzcv >= 0 && nzcv <= 15) {
      return `__a64_fccmp(${operands[0]}, ${operands[1]}, ${nzcv}, "${operands[3].toLowerCase()}");`;
    }
  }

  // MOVI vector immediate. The observed gap is the shifted halfword form, but
  // keep the lowering generic for valid vN.<lanes><b|h|s|d> arrangements.
  if (mnemonic === 'movi' && operands.length >= 2 && /^v\d+\.\d+[bhsd]$/i.test(operands[0])) {
    const imm = parseImm(operands[1]);
    if (imm != null) {
      let shift = 0;
      if (operands.length === 3) {
        const match = /^lsl\s+#?(\d+)$/i.exec(operands[2]);
        if (!match) return null;
        shift = Number(match[1]);
      }
      if (shift >= 0 && shift <= 63) {
        const arrangement = operands[0].split('.')[1].toLowerCase();
        const value = BigInt.asUintN(64, BigInt(imm) << BigInt(shift));
        return `${operands[0].split('.')[0]} = __a64_movi_${arrangement}(0x${value.toString(16)});`;
      }
    }
  }

  return null;
}

export function lowerArm64RawAssembly(result) {
  if (!result?.lines?.length) return result;
  let lowered = 0;
  for (const line of result.lines) {
    if (!line || typeof line.text !== 'string') continue;
    const payload = asmPayload(line.text);
    if (!payload) continue;
    const semantic = lowerOne(payload);
    if (!semantic) continue;
    line.text = semantic;
    line.note = line.note || 'Exact ARM64 instruction semantics lowered from the raw fallback.';
    lowered++;
  }
  if (!lowered) return result;
  result.pseudocode = renderedText(result.lines);
  result.ctx = { ...(result.ctx || {}), exactArm64FallbackLowerings: (result.ctx?.exactArm64FallbackLowerings || 0) + lowered };
  return result;
}
