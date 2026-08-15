import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ByteView } from '../js/binary/reader.js';
import { parseChainedBindingSites } from '../js/binary/macho-dyld.js';

function makeFixture({
  segmentOffset = 0x1000n,
  pageCount = 1,
  pageStart = 0,
  overflow = [],
  pointerFormat = 2,
  raw = 1n << 63n,
  segmentSize = 0x1000n,
  segmentFileSize = 0x1000n,
} = {}) {
  const bytes = new Uint8Array(0x1200);
  const dv = new DataView(bytes.buffer);
  const startsOffset = 0x1c;
  const startsBase = startsOffset;
  const record = startsBase + 8;
  const structSize = 22 + pageCount * 2 + overflow.length * 2;
  dv.setUint32(4, startsOffset, true);
  dv.setUint32(startsBase, 1, true);
  dv.setUint32(startsBase + 4, 8, true);
  dv.setUint32(record, structSize, true);
  dv.setUint16(record + 4, 0x1000, true);
  dv.setUint16(record + 6, pointerFormat, true);
  dv.setBigUint64(record + 8, segmentOffset, true);
  dv.setUint32(record + 16, 0, true);
  dv.setUint16(record + 20, pageCount, true);
  for (let i = 0; i < pageCount; i++) dv.setUint16(record + 22 + i * 2, i === 0 ? pageStart : 0xffff, true);
  const overflowBase = record + 22 + pageCount * 2;
  overflow.forEach((x, i) => dv.setUint16(overflowBase + i * 2, x, true));

  const segment = {
    name: '__DATA', address: 0x2000n, size: segmentSize,
    fileOffset: 0x100n, fileSize: segmentFileSize,
  };
  const chainStart = pageStart & 0x8000 ? ((overflow[0] || 0) & 0x7fff) : pageStart;
  const pointerOff = Number(segment.fileOffset) + chainStart;
  if (pointerOff + 8 <= bytes.length) dv.setBigUint64(pointerOff, raw, true);
  const image = {
    imageBase: 0x1000n,
    segments: [segment],
    metadata: { chainedFixups: { complete: true } },
    warnings: [],
    addressToOffset(address) {
      const a = BigInt(address);
      if (a < segment.address || a >= segment.address + segment.fileSize) return null;
      return segment.fileOffset + (a - segment.address);
    },
  };
  const imports = [{ name: '_target', sites: [] }];
  const status = parseChainedBindingSites(new ByteView(bytes), { offset: 0, size: 0x80 }, image, imports, [segment]);
  return { status, image, imports, segment };
}

// Valid 64-bit chained bind remains accepted.
{
  const { status, imports } = makeFixture();
  assert.equal(status.bindingSitesComplete, true);
  assert.equal(status.bindingSites, 1);
  assert.equal(imports[0].sites.length, 1);
  assert.equal(imports[0].sites[0].address, 0x2000n);
}

// Valid arm64e userland bind remains accepted.
{
  const { status, imports } = makeFixture({ pointerFormat: 9, raw: 1n << 62n });
  assert.equal(status.bindingSitesComplete, true);
  assert.equal(imports[0].sites.length, 1);
}

// A starts record for segIndex 0 cannot point at a different mapped segment.
{
  const { status, imports, image } = makeFixture({ segmentOffset: 0x2000n });
  assert.equal(status.bindingSitesComplete, false);
  assert.equal(imports[0].sites.length, 0);
  assert.ok(image.warnings.some((x) => /segment_offset/.test(x)));
}

// page_count cannot describe pages outside the owning segment.
{
  const { status, imports } = makeFixture({ pageCount: 2, segmentSize: 0x1000n });
  assert.equal(status.bindingSitesComplete, false);
  assert.equal(imports[0].sites.length, 0);
  assert.ok(status.bindingSiteReasons.some((x) => /page_count/.test(x)));
}

// A chain start must fit, including pointer width, in the same file-backed page.
{
  const { status, imports } = makeFixture({ pageStart: 0x0fff });
  assert.equal(status.bindingSitesComplete, false);
  assert.equal(imports[0].sites.length, 0);
  assert.ok(status.bindingSiteReasons.some((x) => /chain start/.test(x)));
}

// MULTI page_start indexes chain_starts[] after the complete page_start[] table.
{
  const { status, imports } = makeFixture({ pageStart: 0x8000, overflow: [0x8010] });
  assert.equal(status.bindingSitesComplete, true);
  assert.equal(imports[0].sites.length, 1);
  assert.equal(imports[0].sites[0].address, 0x2010n);
}

// MULTI index outside chain_starts[] fails closed and creates no site.
{
  const { status, imports } = makeFixture({ pageStart: 0x8001, overflow: [0x8010] });
  assert.equal(status.bindingSitesComplete, false);
  assert.equal(imports[0].sites.length, 0);
  assert.ok(status.bindingSiteReasons.some((x) => /chain_starts index/.test(x)));
}

// next may not jump to the next page. The in-page first binding can be retained,
// but the result is explicitly partial and no out-of-page site is decoded.
{
  const raw = (1n << 63n) | (1023n << 51n);
  const { status, imports } = makeFixture({ raw });
  assert.equal(status.bindingSitesComplete, false);
  assert.equal(imports[0].sites.length, 1);
  assert.ok(status.bindingSiteReasons.some((x) => /chained next leaves its page/.test(x)));
}

// A page in VM zero-fill beyond fileSize can never be used as pointer backing.
{
  const { status, imports } = makeFixture({ pageStart: 0x900, segmentFileSize: 0x800n });
  assert.equal(status.bindingSitesComplete, false);
  assert.equal(imports[0].sites.length, 0);
}

const macho = fs.readFileSync(new URL('../js/binary/macho.js', import.meta.url), 'utf8');
assert.match(macho, /parseChainedBindingSites\([^;]+segmentOrder\)/);
const dyld = fs.readFileSync(new URL('../js/binary/macho-dyld.js', import.meta.url), 'utf8');
assert.match(dyld, /overflowBase = p \+ 22 \+ pageCount \* 2/);
assert.match(dyld, /segmentOffset !== segAddress - image\.imageBase/);
assert.match(dyld, /BigInt\(off\) !== expectedOff/);

console.log('issue #569 chained fixup ownership regressions: PASS');
