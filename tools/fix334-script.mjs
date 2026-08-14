import fs from 'node:fs';
const p='tools/apply-fix334.mjs';
let s=fs.readFileSync(p,'utf8');
const old=`// #338 — ELF PT_LOAD invariants are enforced before mapping.
{
  const p='js/binary/elf.js'; let s=read(p);
  s=s.replace(\`parseProgramHeaders(header, bytes, image);\`, \`parseProgramHeaders(header, bytes, image, BigInt(bytes.byteLength));\`);
  s=s.replace(\`function parseProgramHeaders(header, bytes, image) {\`, \`function parseProgramHeaders(header, bytes, image, fileLength = BigInt(bytes.byteLength)) {\`);
  const add=\`    if (ph.type === PT_LOAD) {\n      const seg = image.addSegment({\`;
  const repl=\`    if (ph.type === PT_LOAD) {\n      if (ph.filesz > ph.memsz) throw new BinaryFormatError('ELF PT_LOAD p_filesz exceeds p_memsz');\n      if (ph.offset < 0n || ph.filesz < 0n || ph.offset > fileLength || ph.filesz > fileLength - ph.offset) throw new BinaryFormatError('ELF PT_LOAD file range exceeds input');\n      const seg = image.addSegment({\`;
  if(!s.includes(add)) throw new Error('ELF PT_LOAD anchor missing'); s=s.replace(add,repl); write(p,s);
}`;
const neu=`// #338 — ELF PT_LOAD invariants are enforced before mapping.
{
  const p='js/binary/elf.js'; let s=read(p);
  s=s.replace(\`const programHeaders = parseProgramHeaders(r, h, image, bits);\`, \`const programHeaders = parseProgramHeaders(r, h, image, bits, BigInt(bytes.byteLength));\`);
  s=s.replace(\`function parseProgramHeaders(r, h, image, bits) {\`, \`function parseProgramHeaders(r, h, image, bits, fileLength = BigInt(r.length)) {\`);
  const add=\`    if (ph.type === PT_LOAD) {\n      image.addSegment({\`;
  const repl=\`    if (ph.type === PT_LOAD) {\n      if (ph.filesz > ph.memsz) throw new Error('ELF PT_LOAD p_filesz exceeds p_memsz');\n      if (ph.offset > fileLength || ph.filesz > fileLength - ph.offset) throw new Error('ELF PT_LOAD file range exceeds input');\n      image.addSegment({\`;
  if(!s.includes(add)) throw new Error('ELF PT_LOAD anchor missing'); s=s.replace(add,repl); write(p,s);
}`;
if(!s.includes(old)) throw new Error('staged ELF block anchor missing');
fs.writeFileSync(p,s.replace(old,neu));
