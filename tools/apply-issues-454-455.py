from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, found {count}')
    p.write_text(text.replace(old, new, 1))


# Architecture adapters own ISA-specific assembly and fixed-size row mapping.
p = Path('js/architecture/index.js')
text = p.read_text()
text = "import { assemble as assembleArm64 } from '../patch.js';\n\n" + text
text = text.replace(
"""    this.decode = definition.decode || null;
    this.controlFlow = definition.controlFlow || (() => null);
""",
"""    this.decode = definition.decode || null;
    this.assemble = definition.assemble || null;
    this.controlFlow = definition.controlFlow || (() => null);
""", 1)
text = text.replace(
"""    this.returnKind = definition.returnKind || (() => null);
    Object.freeze(this);
  }
}
""",
"""    this.returnKind = definition.returnKind || (() => null);
    this.rowForAddress = definition.rowForAddress || ((region, address) => {
      if (this.fixedInstructionSize == null || !region) return null;
      const rel = BigInt(address) - BigInt(region.vmAddr);
      if (rel < 0n || rel >= BigInt(region.size)) return null;
      const size = BigInt(this.fixedInstructionSize);
      if (rel % size !== 0n) return null;
      return Number(rel / size);
    });
    this.addressForRow = definition.addressForRow || ((region, row) => {
      if (this.fixedInstructionSize == null || !region) return null;
      const n = Number(row);
      if (!Number.isSafeInteger(n) || n < 0) return null;
      const address = BigInt(region.vmAddr) + BigInt(n) * BigInt(this.fixedInstructionSize);
      return address < BigInt(region.vmAddr) + BigInt(region.size) ? address : null;
    });
    this.validateInstructionPlacement = definition.validateInstructionPlacement || ((region, address, length) => {
      if (this.fixedInstructionSize == null) return unsupportedArchitectureResult('assemble', this.id);
      const rel = BigInt(address) - BigInt(region?.vmAddr ?? 0n);
      if (!region || rel < 0n || rel >= BigInt(region.size)) return { ok:false, code:'patch-range', error:'アドレスがコードのセクション範囲外です。' };
      if (rel % BigInt(this.instructionAlignment) !== 0n || Number(length) !== this.fixedInstructionSize) {
        return { ok:false, code:'instruction-placement', architecture:this.id, error:`${this.id} 命令の位置または長さが不正です。` };
      }
      return { ok:true };
    });
    Object.freeze(this);
  }
}

export class UnsupportedArchitectureError extends Error {
  constructor(operation, architecture) {
    super(`${operation} is not supported for architecture ${architecture || 'unknown'}`);
    this.name = 'UnsupportedArchitectureError';
    this.code = 'unsupported-architecture';
    this.unsupported = true;
    this.operation = operation;
    this.architecture = String(architecture || 'unknown').toLowerCase();
  }
}

export function unsupportedArchitectureResult(operation, architecture) {
  const error = new UnsupportedArchitectureError(operation, architecture);
  return {
    ok:false,
    unsupported:true,
    code:error.code,
    operation:error.operation,
    architecture:error.architecture,
    error:error.message,
  };
}
""", 1)
text = text.replace(
"""  id: 'arm64', instructionAlignment: 4, fixedInstructionSize: 4, viewerCompatible: true,
  controlFlow(instruction) {
""",
"""  id: 'arm64', instructionAlignment: 4, fixedInstructionSize: 4, viewerCompatible: true,
  assemble: assembleArm64,
  controlFlow(instruction) {
""", 1)
p.write_text(text)

# Script automation uses the architecture adapter instead of a universal 4-byte assumption.
replace_once('js/script.js',
"""import { assemble, parseHexBytes, isHexBytes, validatePatchRange } from './patch.js';
import { Emulator } from './emu.js';
""",
"""import { parseHexBytes, isHexBytes, validatePatchRange } from './patch.js';
import { architectureAdapter, unsupportedArchitectureResult, UnsupportedArchitectureError } from './architecture/index.js';
import { Emulator } from './emu.js';

export { UnsupportedArchitectureError } from './architecture/index.js';
""")

replace_once('js/script.js',
"""  const region = () => app.codeRegion();
  const rowOf = (addr) => {
    const r = region();
    if (!r) return null;
    const rel = BigInt(addr) - r.vmAddr;
    if (rel < 0n || rel >= r.size) return null;
    return Number(rel / 4n);
  };
""",
"""  const region = () => app.codeRegion();
  const architecture = () => String(
    app.store.get('architecture') || app.currentSlice?.()?.capability?.architecture || 'unknown'
  ).toLowerCase();
  const adapter = () => architectureAdapter(architecture());
  const rowOf = (addr) => adapter().rowForAddress(region(), BigInt(addr));
  const addressOfRow = (row) => adapter().addressForRow(region(), row);
""")

replace_once('js/script.js',
"""    async disasm(addr, count = 16) {
      const r = region();
      if (!r) return [];
      const out2 = [];
      let row = rowOf(addr);
      if (row == null) return [];
      for (let i = 0; i < count; i++, row++) {
        const chunk = Math.floor(row / 1024);
        const e = await app.backend.fetchChunk(r.id, chunk, true);
        const k = row - chunk * 1024;
        if (!e.mn || !e.mn[k]) break;
        out2.push({ addr: r.vmAddr + BigInt(row) * 4n, mn: e.mn[k], ops: e.ops ? e.ops[k] : '' });
      }
      return out2;
    },
""",
"""    async disasm(addr, count = 16) {
      const r = region();
      if (!r) return [];
      const a = BigInt(addr);
      const arch = architecture();
      const archAdapter = adapter();
      const limit = Math.max(0, Math.min(10000, Math.trunc(Number(count) || 0)));
      if (!limit) return [];

      // Fixed-size legacy viewers have a stable row<->address mapping owned by
      // the architecture adapter. Variable-length ISAs must use decoder output.
      if (archAdapter.fixedInstructionSize != null) {
        const out2 = [];
        let row = rowOf(a);
        if (row == null) return [];
        for (let i = 0; i < limit; i++, row++) {
          const instructionAddress = addressOfRow(row);
          if (instructionAddress == null) break;
          const chunk = Math.floor(row / 1024);
          const e = await app.backend.fetchChunk(r.id, chunk, true);
          const k = row - chunk * 1024;
          if (!e.mn || !e.mn[k]) break;
          out2.push({ addr:instructionAddress, mn:e.mn[k], ops:e.ops ? e.ops[k] : '' });
        }
        return out2;
      }

      if (typeof app.backend.disassembleAt !== 'function') return unsupportedArchitectureResult('disassemble', arch);
      const decoded = await app.backend.disassembleAt(a, {
        architecture:arch,
        length:Math.min(1024 * 1024, Math.max(64, limit * 16)),
      });
      if (!decoded?.supported) return unsupportedArchitectureResult('disassemble', arch);
      return (decoded.instructions || []).slice(0, limit).map((instruction) => ({
        addr:BigInt(instruction.address),
        size:Number(instruction.size || 0),
        mn:instruction.mnemonic || '',
        ops:instruction.opStr || '',
      }));
    },
""")

replace_once('js/script.js',
"""    /** 命令を組み立てる（4 バイト）。 */
    assemble(text, at) { return assemble(text, BigInt(at)); },
""",
"""    /** 現在のarchitecture用に命令を組み立てる。 */
    assemble(text, at) {
      const arch = architecture();
      const archAdapter = adapter();
      if (typeof archAdapter.assemble !== 'function') return unsupportedArchitectureResult('assemble', arch);
      return archAdapter.assemble(text, BigInt(at));
    },
""")

replace_once('js/script.js',
"""      const built = isHexBytes(textOrHex)
        ? { bytes: parseHexBytes(textOrHex) }
        : assemble(textOrHex, a);
      if (!built.bytes) return built;
      const file = app.store.get('file');
      const valid = validatePatchRange(r, a, built.bytes.length, file && file.size, true);
      if (valid.error) return valid;
      const before = await api.bytes(a, built.bytes.length);
      if (!before || before.length !== built.bytes.length) return { error: '元のバイトを読み取れません。' };
      app.patches.add(valid.fileOffset, before, built.bytes, { addr: a, text: textOrHex });
      return { ok: true, bytes: built.bytes };
""",
"""      const raw = isHexBytes(textOrHex);
      const arch = architecture();
      const archAdapter = adapter();
      let built;
      if (raw) built = { bytes:parseHexBytes(textOrHex) };
      else {
        if (typeof archAdapter.assemble !== 'function') return unsupportedArchitectureResult('assemble', arch);
        built = archAdapter.assemble(textOrHex, a);
      }
      if (!built?.bytes) return built;
      if (!raw) {
        const placement = archAdapter.validateInstructionPlacement(r, a, built.bytes.length);
        if (!placement?.ok) return placement;
      }
      const file = app.store.get('file');
      // Explicit raw bytes are ISA-neutral and may be any in-range length/alignment.
      const valid = validatePatchRange(r, a, built.bytes.length, file && file.size, false);
      if (valid.error) return valid;
      const before = await api.bytes(a, built.bytes.length);
      if (!before || before.length !== built.bytes.length) return { error: '元のバイトを読み取れません。' };
      const mode = raw ? 'raw' : 'assembly';
      app.patches.add(valid.fileOffset, before, built.bytes, { addr:a, text:textOrHex, mode, architecture:arch });
      return { ok:true, bytes:built.bytes, mode, architecture:arch };
""")

replace_once('js/script.js',
"""export function makeEmulator(app) {
  const regions = (app.store.get('regions') || []).filter((r) => r.exec && r.size > 0n);
""",
"""export function makeEmulator(app) {
  const architecture = String(app.store.get('architecture') || app.currentSlice?.()?.capability?.architecture || 'unknown').toLowerCase();
  const adapter = architectureAdapter(architecture);
  if (adapter.id !== 'arm64') throw new UnsupportedArchitectureError('emulate', architecture);
  const regions = (app.store.get('regions') || []).filter((r) => r.exec && r.size > 0n);
""")

replace_once('js/script.js',
"""      const row = Number((addr - r.vmAddr) / 4n);
      const chunk = Math.floor(row / 1024);
""",
"""      const row = adapter.rowForAddress(r, addr);
      if (row == null) return null;
      const chunk = Math.floor(row / 1024);
""")

replace_once('package.json',
"""\"platform:test\": \"node tests/platform-bytesource.mjs""",
"""\"platform:test\": \"node tests/issues-454-455-script-architecture.mjs && node tests/platform-bytesource.mjs""")
