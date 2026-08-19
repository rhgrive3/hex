import fs from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node strip-function-starts.mjs <input> <output>');
  process.exit(2);
}

const buf = fs.readFileSync(input);
if (buf.length < 32 || buf.readUInt32LE(0) !== 0xfeedfacf) {
  throw new Error('expected thin little-endian Mach-O 64 fixture');
}

const ncmds = buf.readUInt32LE(16);
let off = 32;
let patched = 0;
for (let i = 0; i < ncmds; i++) {
  if (off + 8 > buf.length) throw new Error('truncated Mach-O load command table');
  const cmd = buf.readUInt32LE(off);
  const cmdsize = buf.readUInt32LE(off + 4);
  if (cmdsize < 8 || off + cmdsize > buf.length) throw new Error('invalid Mach-O load command size');
  if ((cmd & 0x7fffffff) === 0x26) { // LC_FUNCTION_STARTS
    if (cmdsize < 16) throw new Error('invalid LC_FUNCTION_STARTS size');
    buf.writeUInt32LE(0, off + 12); // linkedit_data_command.datasize
    patched++;
  }
  off += cmdsize;
}
if (patched !== 1) throw new Error(`expected exactly one LC_FUNCTION_STARTS, found ${patched}`);
fs.writeFileSync(output, buf);
console.log(JSON.stringify({ input, output, patched, bytes: buf.length }));
