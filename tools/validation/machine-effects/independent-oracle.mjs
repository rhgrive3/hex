function requireWidth(width) {
  if (!Number.isInteger(width) || width <= 0 || width > 256) throw new Error(`invalid-width: ${width}`);
  return width;
}

export function bitMask(width) {
  requireWidth(width);
  return (1n << BigInt(width)) - 1n;
}

export function unsignedN(value, width) {
  requireWidth(width);
  return BigInt.asUintN(width, BigInt(value));
}

export function signedN(value, width) {
  requireWidth(width);
  return BigInt.asIntN(width, BigInt(value));
}

export function addWithFlags(lhs, rhs, width, carryIn = 0n) {
  requireWidth(width);
  const x = unsignedN(lhs, width);
  const y = unsignedN(rhs, width);
  const carry = BigInt(carryIn) & 1n;
  const full = x + y + carry;
  const result = unsignedN(full, width);
  const signedFull = signedN(x, width) + signedN(y, width) + carry;
  const signedMin = -(1n << BigInt(width - 1));
  const signedMax = (1n << BigInt(width - 1)) - 1n;
  return Object.freeze({
    result,
    N: Number((result >> BigInt(width - 1)) & 1n),
    Z: result === 0n ? 1 : 0,
    C: full > bitMask(width) ? 1 : 0,
    V: signedFull < signedMin || signedFull > signedMax ? 1 : 0,
  });
}

export function subWithFlags(lhs, rhs, width, borrowIn = 0n) {
  requireWidth(width);
  const x = unsignedN(lhs, width);
  const y = unsignedN(rhs, width);
  const borrow = BigInt(borrowIn) & 1n;
  const rhsFull = y + borrow;
  const full = x - rhsFull;
  const result = unsignedN(full, width);
  const signedFull = signedN(x, width) - signedN(y, width) - borrow;
  const signedMin = -(1n << BigInt(width - 1));
  const signedMax = (1n << BigInt(width - 1)) - 1n;
  return Object.freeze({
    result,
    N: Number((result >> BigInt(width - 1)) & 1n),
    Z: result === 0n ? 1 : 0,
    C: x >= rhsFull ? 1 : 0,
    V: signedFull < signedMin || signedFull > signedMax ? 1 : 0,
  });
}

export function logicalFlags(value, width) {
  const result = unsignedN(value, width);
  return Object.freeze({
    result,
    N: Number((result >> BigInt(width - 1)) & 1n),
    Z: result === 0n ? 1 : 0,
    C: 0,
    V: 0,
  });
}

export function lsl(value, amount, width) {
  const shift = BigInt(amount);
  if (shift < 0n) throw new Error('negative-shift');
  if (shift >= BigInt(width)) return 0n;
  return unsignedN(unsignedN(value, width) << shift, width);
}

export function lsr(value, amount, width) {
  const shift = BigInt(amount);
  if (shift < 0n) throw new Error('negative-shift');
  if (shift >= BigInt(width)) return 0n;
  return unsignedN(value, width) >> shift;
}

export function asr(value, amount, width) {
  const shift = BigInt(amount);
  if (shift < 0n) throw new Error('negative-shift');
  const signed = signedN(value, width);
  if (shift >= BigInt(width)) return signed < 0n ? bitMask(width) : 0n;
  return unsignedN(signed >> shift, width);
}

export function ror(value, amount, width) {
  requireWidth(width);
  let shift = BigInt(amount);
  if (shift < 0n) throw new Error('negative-shift');
  shift %= BigInt(width);
  const x = unsignedN(value, width);
  if (shift === 0n) return x;
  return unsignedN((x >> shift) | (x << (BigInt(width) - shift)), width);
}

export function arm64VariableShift(kind, value, amount, width) {
  requireWidth(width);
  const effective = Number(unsignedN(amount, width) % BigInt(width));
  if (kind === 'lsl') return lsl(value, effective, width);
  if (kind === 'lsr') return lsr(value, effective, width);
  if (kind === 'asr') return asr(value, effective, width);
  if (kind === 'ror') return ror(value, effective, width);
  throw new Error(`unsupported-shift-kind: ${kind}`);
}

export function conditionHolds(nzcv, condition) {
  const flags = typeof nzcv === 'number'
    ? { N: (nzcv >> 3) & 1, Z: (nzcv >> 2) & 1, C: (nzcv >> 1) & 1, V: nzcv & 1 }
    : nzcv;
  const { N = 0, Z = 0, C = 0, V = 0 } = flags || {};
  switch (String(condition || '').toLowerCase()) {
    case 'eq': return Z === 1;
    case 'ne': return Z === 0;
    case 'cs': case 'hs': return C === 1;
    case 'cc': case 'lo': return C === 0;
    case 'mi': return N === 1;
    case 'pl': return N === 0;
    case 'vs': return V === 1;
    case 'vc': return V === 0;
    case 'hi': return C === 1 && Z === 0;
    case 'ls': return C === 0 || Z === 1;
    case 'ge': return N === V;
    case 'lt': return N !== V;
    case 'gt': return Z === 0 && N === V;
    case 'le': return Z === 1 || N !== V;
    case 'al': return true;
    case 'nv': return false;
    default: throw new Error(`unsupported-condition: ${condition}`);
  }
}

function extendIndex(index, { indexBits = 64, extend = null } = {}) {
  const op = extend == null ? null : String(extend).toLowerCase();
  if (op === 'sxtw') return signedN(index, 32);
  if (op === 'uxtw') return unsignedN(index, 32);
  if (op === 'sxtx') return signedN(index, 64);
  if (op === 'uxtx' || op === 'lsl' || op == null) return unsignedN(index, indexBits);
  throw new Error(`unsupported-index-extend: ${extend}`);
}

export function calculateArm64Address({
  base,
  displacement = 0n,
  index = null,
  indexBits = 64,
  extend = null,
  shift = 0,
  mode = 'offset',
  addressBits = 64,
} = {}) {
  requireWidth(addressBits);
  const baseValue = unsignedN(base, addressBits);
  let offset = BigInt(displacement || 0n);
  if (index != null) {
    const extended = extendIndex(index, { indexBits, extend });
    offset += extended << BigInt(shift || 0);
  }
  const updatedBase = unsignedN(baseValue + offset, addressBits);
  if (mode === 'offset') return Object.freeze({ address: updatedBase, writeback: null });
  if (mode === 'pre') return Object.freeze({ address: updatedBase, writeback: updatedBase });
  if (mode === 'post') return Object.freeze({ address: baseValue, writeback: updatedBase });
  throw new Error(`unsupported-address-mode: ${mode}`);
}

export function arm64GpRegisterWrite(registerId, value, widthBits) {
  const id = String(registerId || '').toLowerCase();
  if (id === 'xzr' || id === 'wzr' || id === 'zr') {
    return Object.freeze({ ignored: true, physicalRegister: null, value: null, widthBits: 0 });
  }
  if (widthBits !== 32 && widthBits !== 64) throw new Error(`invalid-gp-write-width: ${widthBits}`);
  const match = /^(?:[xw])(\d+)$/.exec(id);
  if (!match) throw new Error(`invalid-gp-register: ${registerId}`);
  const physicalRegister = `x${Number(match[1])}`;
  return Object.freeze({
    ignored: false,
    physicalRegister,
    value: widthBits === 32 ? unsignedN(value, 32) : unsignedN(value, 64),
    widthBits: 64,
    sourceWidthBits: widthBits,
  });
}

export function pcRelativeTarget(address, signedDisplacement, addressBits = 64) {
  return unsignedN(BigInt(address) + BigInt(signedDisplacement), addressBits);
}

export function compareSigned(lhs, rhs, width) {
  const a = signedN(lhs, width);
  const b = signedN(rhs, width);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareUnsigned(lhs, rhs, width) {
  const a = unsignedN(lhs, width);
  const b = unsignedN(rhs, width);
  return a < b ? -1 : a > b ? 1 : 0;
}
