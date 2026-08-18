function parseByteField(text) {
  const tokens = String(text).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.some((token) => !/^[0-9a-f]{2}$/i.test(token))) return null;
  return Uint8Array.from(tokens.map((token) => Number.parseInt(token, 16)));
}

function parsedInstruction(match) {
  const bytes = parseByteField(match[2]);
  if (!bytes?.length) return null;
  const asm = match[3].trim();
  const [mnemonic = '', ...rest] = asm.split(/\s+/);
  return {
    address:BigInt(`0x${match[1]}`),
    bytes,
    length:bytes.length,
    mnemonic,
    operands:rest.join(' '),
    asm,
  };
}

function freezeInstruction(instruction) {
  return Object.freeze({ ...instruction, bytes:Uint8Array.from(instruction.bytes) });
}

export function parseLlvmObjdump(text) {
  const functions = new Map();
  let current = null;
  let pendingLock = null;
  const flushPending = () => {
    if (current && pendingLock) current.instructions.push(freezeInstruction(pendingLock));
    pendingLock = null;
  };

  for (const rawLine of String(text).split(/\r?\n/)) {
    const heading = /^\s*([0-9a-f]+)\s+<([^>]+)>:\s*$/i.exec(rawLine);
    if (heading) {
      flushPending();
      const name = heading[2];
      current = name.startsWith('p5_') ? { name, address:BigInt(`0x${heading[1]}`), instructions:[] } : null;
      if (current) functions.set(name, current);
      continue;
    }
    if (!current) continue;
    const match = /^\s*([0-9a-f]+):\s+((?:[0-9a-f]{2}(?:\s+|$))+)(.*)$/i.exec(rawLine);
    if (!match) continue;
    const instruction = parsedInstruction(match);
    if (!instruction) continue;

    if (pendingLock) {
      const contiguous = instruction.address === pendingLock.address + BigInt(pendingLock.length);
      if (contiguous && pendingLock.bytes.length === 1 && pendingLock.bytes[0] === 0xf0) {
        const bytes = new Uint8Array(pendingLock.length + instruction.length);
        bytes.set(pendingLock.bytes, 0);
        bytes.set(instruction.bytes, pendingLock.length);
        current.instructions.push(freezeInstruction({
          ...instruction,
          address:pendingLock.address,
          bytes,
          length:bytes.length,
          asm:`lock ${instruction.asm}`,
        }));
        pendingLock = null;
        continue;
      }
      flushPending();
    }

    if (instruction.mnemonic.toLowerCase() === 'lock' && instruction.bytes.length === 1 && instruction.bytes[0] === 0xf0) {
      pendingLock = instruction;
      continue;
    }
    current.instructions.push(freezeInstruction(instruction));
  }
  flushPending();

  for (const entry of functions.values()) {
    if (!entry.instructions.length) continue;
    entry.endAddress = entry.instructions.at(-1).address + BigInt(entry.instructions.at(-1).length);
    entry.byteLength = Number(entry.endAddress - entry.address);
    entry.bytes = new Uint8Array(entry.byteLength);
    for (const instruction of entry.instructions) {
      const offset = Number(instruction.address - entry.address);
      entry.bytes.set(instruction.bytes, offset);
    }
  }
  return functions;
}

export function oracleOperandTraits(instruction) {
  const text = String(instruction?.operands || '');
  const mnemonic = String(instruction?.mnemonic || '').toLowerCase();
  const memory = (text.match(/\([^)]*\)/g) || []).length;
  const explicitRegisters = (text.match(/%[a-z][a-z0-9]*/gi) || []).length;
  const dollarImmediates = (text.match(/\$[-+]?0x[0-9a-f]+|\$[-+]?\d+/gi) || []).length;
  const directControlImmediate = /^(?:j[a-z]+|callq?|loop[a-z]*|jrcxz|jecxz|jcxz)$/.test(mnemonic) && memory === 0 && explicitRegisters === 0 ? 1 : 0;
  return Object.freeze({
    memory,
    registers:explicitRegisters,
    immediates:dollarImmediates + directControlImmediate,
    ripRelative:/\(%rip\)/i.test(text),
    sib:/\([^,]+,%[a-z0-9]+,(?:1|2|4|8)\)/i.test(text),
    vexPrefix:instruction?.bytes?.[0] === 0xc4 || instruction?.bytes?.[0] === 0xc5,
  });
}

export function compareDecodedWithOracle(decoded, oracle) {
  const mismatches = [];
  if (BigInt(decoded.address) !== oracle.address) mismatches.push({ kind:'address', expected:String(oracle.address), actual:String(decoded.address) });
  if (Number(decoded.length ?? decoded.size) !== oracle.length) mismatches.push({ kind:'length', expected:oracle.length, actual:Number(decoded.length ?? decoded.size) });
  const actualBytes = [...(decoded.rawBytes || [])];
  const expectedBytes = [...oracle.bytes];
  if (actualBytes.length !== expectedBytes.length || actualBytes.some((value, index) => value !== expectedBytes[index])) mismatches.push({ kind:'bytes', expected:expectedBytes, actual:actualBytes });

  const traits = oracleOperandTraits(oracle);
  const operands = decoded?.detail?.operands || [];
  const actual = {
    memory:operands.filter((operand) => operand.type === 'memory').length,
    registers:operands.filter((operand) => operand.type === 'register').length,
    immediates:operands.filter((operand) => operand.type === 'immediate').length,
  };
  if (traits.memory > actual.memory) mismatches.push({ kind:'operand-memory', expectedAtLeast:traits.memory, actual:actual.memory });
  if (traits.immediates > actual.immediates) mismatches.push({ kind:'operand-immediate', expectedAtLeast:traits.immediates, actual:actual.immediates });
  if (traits.ripRelative && !operands.some((operand) => operand.type === 'memory' && operand.memory?.base?.id === 'rip')) mismatches.push({ kind:'rip-relative', expected:true, actual:false });
  if (traits.sib && !operands.some((operand) => operand.type === 'memory' && operand.memory?.index && [1,2,4,8].includes(operand.memory.scale))) mismatches.push({ kind:'sib', expected:true, actual:false });
  const vectorPrefix = decoded?.detail?.prefixes?.vector ?? null;
  if (traits.vexPrefix && vectorPrefix == null) mismatches.push({ kind:'vex-prefix', expected:true, actual:false });
  if (!traits.vexPrefix && vectorPrefix != null) mismatches.push({ kind:'legacy-vex-confusion', expected:false, actual:true });
  return Object.freeze(mismatches);
}
