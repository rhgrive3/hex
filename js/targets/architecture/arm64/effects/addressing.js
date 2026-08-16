import {
  createBitVectorValue,
  createMachineOperation,
  createRegisterValue,
  createTemporaryValue,
} from '../../../../semantics/effects/index.js';

export class Arm64AddressingError extends TypeError {
  constructor(code, detail = null) {
    super(code);
    this.name = 'Arm64AddressingError';
    this.code = code;
    this.detail = detail;
  }
}

const fail = (code, detail) => { throw new Arm64AddressingError(code, detail); };
const own = (value, key) => value != null && Object.prototype.hasOwnProperty.call(value, key);

function integer(value, code) {
  if (value && typeof value === 'object' && own(value, 'value')) value = value.value;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?(?:0x[0-9a-f]+|\d+)$/i.test(value.trim())) return BigInt(value.trim());
  fail(code);
}

function optionalInteger(value, code) {
  return value == null ? null : integer(value, code);
}

export function arm64RegisterOperand(input) {
  if (typeof input === 'string') {
    const text = input.trim().toLowerCase();
    if (text === 'fp') return { kind: 'gp', physicalId: 'x29', view: 'fp', bits: 64, num: 29, zero: false };
    if (text === 'lr') return { kind: 'gp', physicalId: 'x30', view: 'lr', bits: 64, num: 30, zero: false };
    let match = /^(w|x)(\d|[12]\d|30)$/.exec(text);
    if (match) return { kind: 'gp', physicalId: `x${match[2]}`, view: text, bits: match[1] === 'w' ? 32 : 64, num: Number(match[2]), zero: false };
    if (text === 'wzr' || text === 'xzr') return { kind: 'zero', physicalId: null, view: text, bits: text[0] === 'w' ? 32 : 64, num: 31, zero: true };
    if (text === 'sp' || text === 'wsp') return { kind: 'sp', physicalId: 'sp', view: text, bits: text === 'wsp' ? 32 : 64, num: 31, zero: false };
    match = /^([bhsdq])(\d|[12]\d|3[01])$/.exec(text);
    if (match) {
      const bits = { b:8, h:16, s:32, d:64, q:128 }[match[1]];
      return { kind: 'vector', physicalId: `v${match[2]}`, view: text, bits, num: Number(match[2]), zero: false };
    }
    match = /^v(\d|[12]\d|3[01])(?:\..+)?$/.exec(text);
    if (match) return { kind: 'vector', physicalId: `v${match[1]}`, view: text, bits: 128, num: Number(match[1]), zero: false };
    return null;
  }

  if (!input || typeof input !== 'object') return null;
  if (typeof input.physicalId === 'string' && typeof input.kind === 'string') {
    const parsed = arm64RegisterOperand(input.view || input.physicalId);
    if (parsed) return { ...parsed, bits:Number(input.bits || parsed.bits), kind:input.kind, zero:!!input.zero };
  }
  if (input.k === 'reg') {
    if (input.cls === 'zr') return arm64RegisterOperand(input.text || (Number(input.bits) === 32 ? 'wzr' : 'xzr'));
    if (input.cls === 'sp') return arm64RegisterOperand(input.text || (Number(input.bits) === 32 ? 'wsp' : 'sp'));
    if (input.cls === 'gp') {
      const num = Number(input.num);
      if (!Number.isInteger(num) || num < 0 || num > 30) return null;
      return arm64RegisterOperand(input.text || `${Number(input.bits) === 32 ? 'w' : 'x'}${num}`);
    }
    if (input.cls === 'fp' || input.cls === 'vec') {
      const num = Number(input.num);
      if (!Number.isInteger(num) || num < 0 || num > 31) return null;
      if (input.text) return arm64RegisterOperand(input.text);
      const prefix = ({8:'b',16:'h',32:'s',64:'d',128:'q'})[Number(input.bits)] || 'q';
      return arm64RegisterOperand(`${prefix}${num}`);
    }
  }

  if (typeof input.registerId === 'string') {
    const parsed = arm64RegisterOperand(input.view || input.registerId);
    if (parsed) return { ...parsed, bits: Number(input.widthBits || parsed.bits) };
  }
  if (typeof input.text === 'string') return arm64RegisterOperand(input.text);
  return null;
}

export function arm64Temporary(id, widthBits) {
  return createTemporaryValue(id, createBitVectorValue(widthBits));
}

export function arm64TemporaryExpr(id, widthBits) {
  return { kind: 'temporary', temporaryId: String(id), widthBits: Number(widthBits) };
}

export function arm64ConstantExpr(value, widthBits = 64) {
  return { kind: 'bitvector', widthBits: Number(widthBits), value: BigInt.asUintN(Number(widthBits), BigInt(value)).toString() };
}

export function arm64AddressAdd(left, right) {
  return { kind: 'add', widthBits: 64, left, right };
}

export function arm64AddressOffset(addressExpr, byteOffset) {
  const value = BigInt(byteOffset);
  if (value === 0n) return addressExpr;
  return arm64AddressAdd(addressExpr, arm64ConstantExpr(value, 64));
}

function registerValue(reg, widthBits = reg.bits) {
  return createRegisterValue(reg.physicalId, widthBits, reg.view ? { view: reg.view } : {});
}

export function createArm64RegisterRead(regInput, temporaryId, widthBits = null) {
  const reg = arm64RegisterOperand(regInput);
  if (!reg || reg.zero) fail('arm64-invalid-register-read');
  const bits = Number(widthBits || reg.bits);
  const value = arm64Temporary(temporaryId, bits);
  return {
    reg,
    value,
    operation: createMachineOperation({
      kind: 'register-read',
      register: registerValue(reg, bits),
      value,
      metadata: { architecture: 'arm64', view: reg.view },
    }),
  };
}

export function createArm64RegisterWrite(regInput, value, { metadata = null, physicalWidth = null } = {}) {
  const reg = arm64RegisterOperand(regInput);
  if (!reg || reg.zero) fail('arm64-invalid-register-write');
  const bits = Number(physicalWidth || (reg.kind === 'gp' ? 64 : reg.kind === 'sp' ? 64 : 128));
  return createMachineOperation({
    kind: 'register-write',
    register: createRegisterValue(reg.physicalId, bits, reg.view ? { view: reg.view } : {}),
    value,
    metadata: { architecture: 'arm64', view: reg.view, ...(metadata || {}) },
  });
}

function extendIndex(expr, reg, shift, accessWidthBits = null) {
  if (!shift) {
    if (reg.bits === 64) return expr;
    fail('arm64-register-offset-needs-extension', { register: reg.view });
  }
  const op = String(shift.op || '').toLowerCase();
  const amount = shift.amount == null ? 0 : Number(shift.amount);
  if (!Number.isInteger(amount) || amount < 0 || amount > 4) fail('arm64-invalid-register-offset-shift');
  if (accessWidthBits != null && amount !== 0) {
    const bytes = Number(accessWidthBits) / 8;
    const expected = Number.isInteger(bytes) && bytes > 0 ? Math.log2(bytes) : NaN;
    if (!Number.isInteger(expected) || amount !== expected) fail('arm64-register-offset-shift-does-not-match-access-width', { amount, accessWidthBits });
  }

  let extended;
  if (op === 'uxtw') {
    if (reg.bits !== 32) fail('arm64-uxtw-requires-w-register');
    extended = { kind: 'zero-extend', fromBits: 32, toBits: 64, value: expr };
  } else if (op === 'sxtw') {
    if (reg.bits !== 32) fail('arm64-sxtw-requires-w-register');
    extended = { kind: 'sign-extend', fromBits: 32, toBits: 64, value: expr };
  } else if (op === 'sxtx') {
    if (reg.bits !== 64) fail('arm64-sxtx-requires-x-register');
    extended = expr;
  } else if (op === 'lsl') {
    if (reg.bits !== 64) fail('arm64-lsl-register-offset-requires-x-register');
    extended = expr;
  } else {
    fail('arm64-unsupported-register-offset-extension', { op });
  }

  if (amount === 0) return extended;
  return { kind: 'shift-left', widthBits: 64, value: extended, amount };
}

function memoryOperand(decoded) {
  const operands = Array.isArray(decoded?.ops) ? decoded.ops : Array.isArray(decoded?.operands) ? decoded.operands : [];
  return operands.find((operand) => operand?.k === 'mem' || operand?.kind === 'memory') || null;
}

function memBase(mem) {
  return arm64RegisterOperand(mem?.base ?? mem?.baseRegister ?? null);
}

function memIndex(mem) {
  return arm64RegisterOperand(mem?.index ?? mem?.indexRegister ?? null);
}

function addressingMode(mem) {
  const mode = String(mem?.mode || mem?.addressingMode || 'offset').toLowerCase();
  if (!['offset', 'pre', 'post'].includes(mode)) fail('arm64-unsupported-addressing-mode', { mode });
  return mode;
}

function addressDisplacement(mem, mode) {
  if (own(mem, 'addressDisp')) return optionalInteger(mem.addressDisp, 'arm64-invalid-address-displacement');
  if (mode === 'post') return 0n;
  if (own(mem, 'disp')) return optionalInteger(mem.disp, 'arm64-invalid-address-displacement');
  if (own(mem, 'offset') && mem.index == null && mem.indexRegister == null) return optionalInteger(mem.offset, 'arm64-invalid-address-displacement');
  return 0n;
}

function writebackDisplacement(mem, mode, addressDisp) {
  if (mode === 'offset') return null;
  if (own(mem, 'writebackDisp')) return optionalInteger(mem.writebackDisp, 'arm64-invalid-writeback-displacement');
  if (own(mem, 'writebackOffset')) return optionalInteger(mem.writebackOffset, 'arm64-invalid-writeback-displacement');
  if (mode === 'pre') return addressDisp;
  if (own(mem, 'disp')) return optionalInteger(mem.disp, 'arm64-invalid-writeback-displacement');
  fail('arm64-post-index-writeback-required');
}

function mnemonicEncoding(decoded, index) {
  const mnemonic = String(decoded?.mnemonic || '').toLowerCase();
  if (/^(?:ldur|stur|ldtr|sttr)/.test(mnemonic)) return 'unscaled';
  if (index) return 'register-offset';
  return 'scaled-or-immediate';
}

export function buildArm64EffectiveAddress(decoded, options = {}) {
  const mem = memoryOperand(decoded);
  if (!mem) fail('arm64-memory-operand-required');
  const prefix = String(options.prefix || 'addr');
  const mode = addressingMode(mem);
  const base = memBase(mem);
  if (!base || base.zero || !['gp', 'sp'].includes(base.kind) || base.bits !== 64) fail('arm64-invalid-memory-base-register');
  const index = memIndex(mem);
  if (index && !['gp'].includes(index.kind)) fail('arm64-invalid-memory-index-register');
  if (mode !== 'offset' && index) fail('arm64-writeback-register-offset-unsupported');

  const baseRead = createArm64RegisterRead(base, `${prefix}.base`, 64);
  const readOperations = [baseRead.operation];
  const baseExpr = arm64TemporaryExpr(`${prefix}.base`, 64);
  const addressDisp = addressDisplacement(mem, mode);
  let offsetExpr = arm64ConstantExpr(addressDisp || 0n, 64);
  let offsetKind = 'immediate';

  if (index) {
    if (addressDisp && addressDisp !== 0n) fail('arm64-register-offset-cannot-have-immediate-displacement');
    const indexRead = createArm64RegisterRead(index, `${prefix}.index`, index.bits);
    readOperations.push(indexRead.operation);
    offsetExpr = extendIndex(arm64TemporaryExpr(`${prefix}.index`, index.bits), index, mem.shift || mem.extend || null, options.accessWidthBits ?? null);
    offsetKind = 'register';
  }

  const effectiveWithOffset = arm64AddressAdd(baseExpr, offsetExpr);
  const addressExpr = mode === 'post' ? baseExpr : effectiveWithOffset;
  const wbDisp = writebackDisplacement(mem, mode, addressDisp);
  const writebackOperations = [];
  let writebackExpr = null;

  if (mode !== 'offset') {
    if (wbDisp == null) fail('arm64-writeback-displacement-required');
    writebackExpr = arm64AddressAdd(baseExpr, arm64ConstantExpr(wbDisp, 64));
    const wbValue = arm64Temporary(`${prefix}.writeback`, 64);
    writebackOperations.push(createMachineOperation({
      kind: 'value',
      opcode: 'add',
      inputs: [baseRead.value, createBitVectorValue(64, BigInt.asUintN(64, wbDisp))],
      outputs: [wbValue],
      metadata: { architecture: 'arm64', purpose: 'address-writeback', mode },
    }));
    writebackOperations.push(createArm64RegisterWrite(base, wbValue, {
      physicalWidth: 64,
      metadata: { purpose: 'address-writeback', mode },
    }));
  }

  return Object.freeze({
    mem,
    base,
    index,
    mode,
    addressExpr,
    readOperations: Object.freeze(readOperations),
    writebackOperations: Object.freeze(writebackOperations),
    writebackExpr,
    metadata: Object.freeze({
      mode,
      baseRegister: base.physicalId,
      baseView: base.view,
      stack: base.kind === 'sp',
      offsetKind,
      encoding: mnemonicEncoding(decoded, index),
      ...(index ? { indexRegister: index.physicalId, indexView: index.view, extend: mem.shift?.op || mem.extend?.op || null, shift: mem.shift?.amount ?? mem.extend?.amount ?? 0 } : {}),
      ...(addressDisp != null ? { addressDisplacement: addressDisp.toString() } : {}),
      ...(wbDisp != null ? { writebackDisplacement: wbDisp.toString() } : {}),
    }),
  });
}
