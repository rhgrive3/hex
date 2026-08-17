import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DEPLOYED_CAPSTONE_SUPPORT } from '../js/platform/capstone-capability.js';
import { describeBinaryImage } from '../js/platform/describe.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = path.join(os.tmpdir(), `hex-capstone-${process.pid}-${Date.now()}.cjs`);
fs.copyFileSync(path.join(root, 'capstone.js'), temp);

try {
  const require = createRequire(import.meta.url);
  const MCapstone = require(temp);
  assert.equal(typeof MCapstone, 'function', 'deployed capstone.js must expose its Emscripten factory');
  const M = await MCapstone({
    locateFile: (name) => path.join(root, name),
    print: () => {},
    printErr: () => {},
  });

  const probe = (arch, mode) => {
    const hp = M._malloc(4);
    try {
      const rc = M.ccall('cs_open', 'number', ['number', 'number', 'pointer'], [arch, mode, hp]);
      if (rc !== 0) return false;
      const handle = M.getValue(hp, 'i32');
      if (handle) M.ccall('cs_close', 'number', ['pointer'], [hp]);
      return true;
    } finally {
      M._free(hp);
    }
  };

  const support = {
    arm64: probe(M.ARCH_ARM64, M.MODE_ARM | M.MODE_LITTLE_ENDIAN),
    x86_64: probe(M.ARCH_X86, M.MODE_64 | M.MODE_LITTLE_ENDIAN),
  };

  assert.deepEqual(support, DEPLOYED_CAPSTONE_SUPPORT, 'capability claims must exactly match the deployed Capstone build');

  const x86Descriptor = describeBinaryImage({
    format: 'elf', arch: 'x86_64', bits: 64, endian: 'little',
    sections: [], segments: [], imageBase: 0n, fileOffset: 0n, fileSize: 0n,
    warnings: [], metadata: {}, summary: () => ({ format: 'elf', arch: 'x86_64', bits: 64 }),
  }, { engine: { ...support, verified: true } });
  assert.equal(x86Descriptor.capability.canDisassemble, true);
  assert.equal(x86Descriptor.capability.canAnalyzeDataflow, false);
  assert.equal(x86Descriptor.capability.canEmulate, false);
  assert.equal(x86Descriptor.capability.viewerCanDisassemble, false, 'fixed-width viewer must not claim x86 support');
  assert.equal(x86Descriptor.capability.engineVerified, true);

  console.log('capstone-capability:', JSON.stringify(support));
} finally {
  fs.rmSync(temp, { force: true });
}
