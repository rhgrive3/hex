'use strict';
importScripts(
  '../targets/architecture/x86_64/capstone-structured.js',
  '../targets/architecture/riscv64/capstone-structured.js',
  '../../capstone.js',
);

const CS_INSN_STRUCT = 240;
const OFF_SIZE = 16, OFF_MNEMONIC = 42, OFF_OP_STR = 74;
let modulePromise = null;
const handles = new Map();

async function getModule() {
  if (!modulePromise) modulePromise = MCapstone({
    locateFile: (p) => new URL('../../' + p, self.location.href).href,
    print: () => {}, printErr: () => {},
  }).catch((error) => { throw new Error(`Capstone disassembler initialization: ${error?.message || String(error)}`); });
  return modulePromise;
}

async function handleFor(architecture) {
  if (handles.has(architecture)) return handles.get(architecture);
  const M = await getModule();
  let arch, mode;
  if (architecture === 'arm64') { arch = M.ARCH_ARM64; mode = M.MODE_ARM | M.MODE_LITTLE_ENDIAN; }
  else if (architecture === 'x86_64') { arch = M.ARCH_X86; mode = M.MODE_64 | M.MODE_LITTLE_ENDIAN; }
  else if (architecture === 'riscv64') { arch = M.ARCH_RISCV; mode = M.MODE_RISCV64 | M.MODE_RISCVC | M.MODE_LITTLE_ENDIAN; }
  else throw new Error(`Unsupported architecture: ${architecture}`);
  const hp = M._malloc(4);
  const rc = M.ccall('cs_open', 'number', ['number', 'number', 'pointer'], [arch, mode, hp]);
  if (rc !== 0) { M._free(hp); throw new Error(`Capstone cannot open ${architecture} (error ${rc})`); }
  const handle = M.getValue(hp, 'i32');
  M.ccall('cs_option', 'number', ['number', 'number', 'number'], [handle, M.OPT_SKIPDATA, M.OPT_ON]);
  if (architecture === 'x86_64') {
    globalThis.HexX86CapstoneStructured.verifyVersion(M);
    const detailRc = M.ccall('cs_option', 'number', ['number', 'number', 'number'], [handle, M.OPT_DETAIL, M.OPT_ON]);
    if (detailRc !== 0) throw new Error(`Capstone cannot enable x86 detail (error ${detailRc})`);
  } else if (architecture === 'riscv64') {
    globalThis.HexRiscv64CapstoneStructured.verifyVersion(M);
    const detailRc = M.ccall('cs_option', 'number', ['number', 'number', 'number'], [handle, M.OPT_DETAIL, M.OPT_ON]);
    if (detailRc !== 0) throw new Error(`Capstone cannot enable RISC-V detail (error ${detailRc})`);
  }
  const state = { M, hp, handle, out: M._malloc(4) };
  handles.set(architecture, state);
  return state;
}

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    const { M, handle, out } = await handleFor(msg.architecture);
    const bytes = msg.bytes instanceof Uint8Array ? msg.bytes : new Uint8Array(msg.bytes || 0);
    if (bytes.length > 1024 * 1024) throw new Error('disassembly request exceeds 1 MiB');
    const buf = M._malloc(Math.max(1, bytes.length));
    try {
      if (bytes.length) M.writeArrayToMemory(bytes, buf);
      const count = M.ccall('cs_disasm', 'number', ['number','number','number','number','number','number'],
        [handle, buf, bytes.length, msg.address, 0, out]);
      const base = count ? M.getValue(out, 'i32') : 0;
      const instructions = [];
      let consumed = 0;
      try {
        for (let i = 0; i < count; i++) {
          const p = base + i * CS_INSN_STRUCT;
          const size = M.getValue(p + OFF_SIZE, 'i16');
          if (!(size > 0)) break;
          if (msg.architecture === 'x86_64') {
            instructions.push(globalThis.HexX86CapstoneStructured.parseInstruction(M, handle, p, {
              address:BigInt(msg.address) + BigInt(consumed),
              mode:'long-64',
            }));
          } else if (msg.architecture === 'riscv64') {
            instructions.push(globalThis.HexRiscv64CapstoneStructured.parseInstruction(M, handle, p, {
              address:BigInt(msg.address) + BigInt(consumed),
              mode:'rv64imc',
            }));
          } else {
            instructions.push({
              address: BigInt(msg.address) + BigInt(consumed),
              size,
              mnemonic: M.UTF8ToString(p + OFF_MNEMONIC),
              opStr: M.UTF8ToString(p + OFF_OP_STR),
            });
          }
          consumed += size;
        }
      } finally {
        if (base) M.ccall('cs_free', 'void', ['number','number'], [base, count]);
      }
      self.postMessage({ id: msg.id, ok: true, instructions, bytesConsumed: consumed });
    } finally { M._free(buf); }
  } catch (error) {
    self.postMessage({ id: msg.id, ok: false, error: error?.message || String(error) });
  }
};
