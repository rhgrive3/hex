import assert from 'node:assert/strict';
import { BinaryImage } from '../js/binary/model.js';

const data = new Uint8Array(0x300);
data.set([0xaa, 0xbb, 0xcc, 0xdd], 0x100);
data.set([0x11, 0x22, 0x33, 0x44], 0x104); // unrelated raw-file bytes
data.set([0x51, 0x52], 0x200);

function imageWithTail(bytes = data) {
  const image = new BinaryImage(bytes, { format:'elf' });
  image.addSegment({
    name:'LOAD0', address:0x1000n, size:8n,
    fileOffset:0x100n, fileSize:4n,
    perms:{ read:true }, source:'PT_LOAD',
  });
  return image;
}

const resident = imageWithTail();
assert.deepEqual([...resident.readVirtual(0x1000n, 4)], [0xaa,0xbb,0xcc,0xdd], 'fully file-backed reads remain unchanged');
assert.deepEqual([...resident.readVirtual(0x1002n, 4)], [0xcc,0xdd,0,0], 'file-backed -> BSS tail must compose mapped bytes plus zero-fill');
assert.deepEqual([...resident.readVirtual(0x1004n, 4)], [0,0,0,0], 'fully zero-fill reads must synthesize zero bytes');
assert.equal(resident.addressToOffset(0x1004n), null, 'zero-fill VA must not resolve to unrelated raw-file bytes');
assert.equal(resident.resolveVirtualMapping(0x1004n)?.kind, 'zero');

const gap = new BinaryImage(data, { format:'elf' });
gap.addSegment({ address:0x1000n, size:4n, fileOffset:0x100n, fileSize:4n, perms:{read:true} });
gap.addSegment({ address:0x2000n, size:2n, fileOffset:0x200n, fileSize:2n, perms:{read:true} });
assert.equal(gap.readVirtual(0x1002n, 4), null, 'file-backed -> unmapped gap must fail closed');

const contiguous = new BinaryImage(data, { format:'pe' });
contiguous.addSegment({ address:0x3000n, size:2n, fileOffset:0x100n, fileSize:2n, perms:{read:true} });
contiguous.addSegment({ address:0x3002n, size:2n, fileOffset:0x200n, fileSize:2n, perms:{read:true} });
assert.deepEqual([...contiguous.readVirtual(0x3000n, 4)], [0xaa,0xbb,0x51,0x52], 'VA-contiguous mappings with non-contiguous file offsets must compose per mapping');

const machoSparse = new BinaryImage(data, { format:'macho' });
machoSparse.addSegment({ address:0x4000n, size:8n, fileOffset:0x100n, fileSize:8n, perms:{read:true}, source:'LC_SEGMENT_64' });
machoSparse.addSection({ name:'__bss', segment:'__DATA', address:0x4004n, size:4n, fileOffset:0n, fileSize:0n, perms:{read:true,write:true}, source:'LC_SEGMENT_64' });
assert.deepEqual([...machoSparse.readVirtual(0x4002n, 4)], [0xcc,0xdd,0,0], 'zero-fill child section must override broader segment raw-file continuity');

const source = {
  size: BigInt(data.length),
  async readExactly(offset, size) {
    const o = Number(offset), n = Number(size);
    assert.ok(Number.isSafeInteger(o) && Number.isSafeInteger(n) && o >= 0 && n >= 0 && o + n <= data.length);
    return data.slice(o, o + n);
  },
};
const streamed = imageWithTail();
streamed.attachSource(source, { discardBytes:true });
assert.deepEqual([...await streamed.readVirtualAsync(0x1002n, 4n)], [0xcc,0xdd,0,0], 'streaming path must share resident mapping semantics');
assert.deepEqual([...await streamed.readVirtualAsync(0x1004n, 4n)], [0,0,0,0], 'streaming zero-fill must not read source bytes');

const streamedGap = new BinaryImage(null, { format:'elf', source, fileSize:source.size });
streamedGap.addSegment({ address:0x1000n, size:4n, fileOffset:0x100n, fileSize:4n, perms:{read:true} });
streamedGap.addSegment({ address:0x2000n, size:2n, fileOffset:0x200n, fileSize:2n, perms:{read:true} });
assert.equal(await streamedGap.readVirtualAsync(0x1002n, 4n), null, 'streaming path must fail closed across unmapped VA gaps');

console.log('issue 970 mapping-aware BinaryImage virtual read regression: PASS');
