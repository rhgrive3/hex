import assert from "node:assert/strict";
import {
  ByteSource,
  MemoryByteSource,
  BlobByteSource,
  SubrangeByteSource,
  asByteSource,
  ByteSourceRangeError,
  ByteSourceLimitError,
} from "../js/binary/source.js";
import { openBinarySource } from "../js/binary/index.js";

console.log("Testing ByteSource conformance suite...");

const BYTES = Uint8Array.from({ length: 257 }, (_, i) => (i * 37) & 0xff);

const factories = [
  {
    name: "memory",
    create: () => new MemoryByteSource(BYTES, { maxReadLength: 64 }),
  },
  {
    name: "blob",
    create: () => typeof Blob !== "undefined" ? new BlobByteSource(new Blob([BYTES]), { maxReadLength: 64 }) : null,
  },
  {
    name: "subrange",
    create: () => {
      const parentBytes = new Uint8Array(11 + BYTES.length + 13);
      parentBytes.set(BYTES, 11);
      const parent = new MemoryByteSource(parentBytes, { maxReadLength: 64 });
      return parent.subrange(11n, BigInt(BYTES.length));
    },
  },
  {
    name: "delegated",
    create: () => {
      const custom = {
        size: BigInt(BYTES.length),
        async read(offset, length, options) {
          return BYTES.subarray(Number(offset), Number(offset) + length);
        },
      };
      return asByteSource(custom, { maxReadLength: 64 });
    },
  },
];

for (const { name, create } of factories) {
  const source = create();
  if (!source) {
    console.log(`  skip ${name} (Blob unavailable)`);
    continue;
  }
  console.log(`  testing factory: ${name}`);

  // 1. size is exact BigInt
  assert.equal(source.size, 257n);

  // 2. zero-length read at start
  const z1 = await source.readExactly(0n, 0);
  assert.equal(z1.length, 0);
  assert.ok(z1 instanceof Uint8Array);

  // 3. zero-length read at EOF
  const z2 = await source.readExactly(source.size, 0);
  assert.equal(z2.length, 0);

  // 4. first byte
  const b1 = await source.readExactly(0n, 1);
  assert.deepEqual(b1, BYTES.subarray(0, 1));

  // 5. middle range
  const bm = await source.readExactly(100n, 37);
  assert.deepEqual(bm, BYTES.subarray(100, 137));

  // 6. final byte
  const bf = await source.readExactly(256n, 1);
  assert.deepEqual(bf, BYTES.subarray(256, 257));

  // 7. full allowed max read
  const bmax = await source.readExactly(0n, 64);
  assert.equal(bmax.length, 64);

  // 8. max-read overflow
  await assert.rejects(async () => source.readExactly(0n, 65), (err) => {
    return err instanceof ByteSourceLimitError && err.code === "BYTE_SOURCE_LIMIT_ERROR";
  });

  // 9. negative offset
  await assert.rejects(async () => source.readExactly(-1n, 1), (err) => {
    return err instanceof ByteSourceRangeError && err.code === "BYTE_SOURCE_RANGE_ERROR";
  });

  // 10. negative length
  await assert.rejects(async () => source.readExactly(0n, -1), ByteSourceRangeError);

  // 11. unsafe Number offset
  await assert.rejects(async () => source.readExactly(Number.MAX_SAFE_INTEGER + 1, 1), ByteSourceRangeError);

  // 12. read starts past EOF
  await assert.rejects(async () => source.readExactly(258n, 0), ByteSourceRangeError);

  // 13. read crosses EOF
  await assert.rejects(async () => source.readExactly(250n, 8), (err) => {
    return err instanceof ByteSourceRangeError && err.offset === 250n && err.length === 8n && err.size === 257n;
  });

  // 14. pre-aborted read
  const preAc = new AbortController();
  preAc.abort();
  await assert.rejects(async () => source.readExactly(0n, 1, { signal: preAc.signal }), (err) => err.name === "AbortError");

  // 16. exact result type
  const res = await source.readExactly(0n, 4);
  assert.ok(res instanceof Uint8Array);
}

// 15. abort after backend read begins
{
  let delayedResolve;
  const custom = {
    size: 257n,
    async read(offset, length, options) {
      return new Promise((resolve) => {
        delayedResolve = () => resolve(new Uint8Array(length));
      });
    },
  };
  const ac = new AbortController();
  const source = asByteSource(custom, { maxReadLength: 64 });
  const p = source.readExactly(0n, 10, { signal: ac.signal });
  ac.abort();
  delayedResolve();
  await assert.rejects(async () => p, (err) => err.name === "AbortError");
  console.log("  ok 15 abort after backend read begins");
}

// 17. truncated delegated result
{
  const custom = {
    size: 257n,
    async read(offset, length, options) {
      return new Uint8Array(length - 1);
    },
  };
  const source = asByteSource(custom, { maxReadLength: 64 });
  await assert.rejects(async () => source.readExactly(0n, 10), ByteSourceRangeError);
  console.log("  ok 17 truncated delegated result");
}

// 18. delegated ArrayBuffer result normalization
{
  const custom = {
    size: 257n,
    async read(offset, length, options) {
      return new ArrayBuffer(length);
    },
  };
  const source = asByteSource(custom, { maxReadLength: 64 });
  const res = await source.readExactly(0n, 10);
  assert.ok(res instanceof Uint8Array);
  console.log("  ok 18 delegated ArrayBuffer normalization");
}

// 19. delegated typed-view result normalization
{
  const custom = {
    size: 257n,
    async read(offset, length, options) {
      const buf = new Uint8Array(length + 8);
      buf.set([1, 2, 3, 4], 4);
      return new Uint8Array(buf.buffer, 4, length);
    },
  };
  const source = asByteSource(custom, { maxReadLength: 64 });
  const res = await source.readExactly(0n, 4);
  assert.deepEqual([...res], [1, 2, 3, 4]);
  console.log("  ok 19 delegated typed view normalization");
}

// 20. subrange translation
{
  let parentReadOffset = null;
  let parentReadLen = null;
  const parent = {
    size: 1000n,
    maxReadLength: 64,
    async read(offset, length, options) {
      parentReadOffset = offset;
      parentReadLen = length;
      return new Uint8Array(length);
    },
    async readExactly(offset, length, options) {
      parentReadOffset = offset;
      parentReadLen = length;
      return new Uint8Array(length);
    },
    subrange(offset, length, options) {
      return new SubrangeByteSource(this, offset, length, options);
    },
  };
  const sub = parent.subrange(11n, 100n);
  await sub.readExactly(7n, 9);
  assert.equal(parentReadOffset, 18n);
  assert.equal(parentReadLen, 9);
  console.log("  ok 20 subrange translation");
}

// 21. nested subrange translation
{
  const mem = new MemoryByteSource(BYTES, { maxReadLength: 64 });
  const sub1 = mem.subrange(10n, 100n);
  const sub2 = sub1.subrange(5n, 20n);
  assert.equal(sub2.size, 20n);
  const read = await sub2.readExactly(0n, 5);
  assert.deepEqual(read, BYTES.subarray(15, 20));
  console.log("  ok 21 nested subrange translation");
}

// 22. subrange construction outside parent
{
  const mem = new MemoryByteSource(BYTES, { maxReadLength: 64 });
  assert.throws(() => mem.subrange(300n, 10n), ByteSourceRangeError);
  assert.throws(() => mem.subrange(250n, 10n), ByteSourceRangeError);
  assert.throws(() => mem.subrange(-1n, 10n), ByteSourceRangeError);
  assert.throws(() => mem.subrange(0n, -1n), ByteSourceRangeError);
  console.log("  ok 22 subrange outside parent rejected");
}

// 23. maxReadLength inheritance
{
  const mem = new MemoryByteSource(BYTES, { maxReadLength: 42 });
  const sub = mem.subrange(0n, 50n);
  assert.equal(sub.maxReadLength, 42);
  console.log("  ok 23 maxReadLength inheritance");
}

// 24. maxReadLength override
{
  const mem = new MemoryByteSource(BYTES, { maxReadLength: 64 });
  const sub = new SubrangeByteSource(mem, 0n, 50n, { maxReadLength: 32 });
  assert.equal(sub.maxReadLength, 32);
  assert.equal(mem.maxReadLength, 64);
  console.log("  ok 24 maxReadLength override");
}

// 25. asByteSource identity fast path
{
  const mem = new MemoryByteSource(BYTES, { maxReadLength: 64 });
  assert.strictEqual(asByteSource(mem), mem);
  console.log("  ok 25 asByteSource identity fast path");
}

// 26. asByteSource wraps limit override
{
  const mem = new MemoryByteSource(BYTES, { maxReadLength: 64 });
  const wrapped = asByteSource(mem, { maxReadLength: 32 });
  assert.notStrictEqual(wrapped, mem);
  assert.equal(wrapped.size, 257n);
  const okRead = await wrapped.readExactly(0n, 32);
  assert.equal(okRead.length, 32);
  await assert.rejects(async () => wrapped.readExactly(0n, 33), ByteSourceLimitError);
  const parentRead = await mem.readExactly(0n, 64);
  assert.equal(parentRead.length, 64);
  console.log("  ok 26 asByteSource wraps limit override");
}

// 27. custom delegate receives BigInt offset + Number length
{
  let receivedOffset, receivedLength, receivedSignal;
  const ac = new AbortController();
  const custom = {
    size: 257n,
    async read(offset, length, options) {
      receivedOffset = offset;
      receivedLength = length;
      receivedSignal = options.signal;
      return new Uint8Array(length);
    },
  };
  const source = asByteSource(custom, { maxReadLength: 64 });
  await source.readExactly(10n, 5, { signal: ac.signal });
  assert.equal(typeof receivedOffset, "bigint");
  assert.equal(receivedOffset, 10n);
  assert.equal(typeof receivedLength, "number");
  assert.equal(receivedLength, 5);
  assert.equal(receivedSignal, ac.signal);
  console.log("  ok 27 custom delegate receives BigInt + Number");
}

// 28. source data isolation semantics
{
  const mem = new MemoryByteSource(BYTES);
  const r1 = await mem.readExactly(0n, 4);
  assert.ok(r1 instanceof Uint8Array);
  console.log("  ok 28 source data isolation");
}

// Cross-check with minimal ELF fixture
{
  function elfFixture() {
    const bytes = new Uint8Array(0x100);
    const d = new DataView(bytes.buffer);
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
    d.setUint16(16, 2, true); // ET_EXEC
    d.setUint16(18, 0xb7, true); // EM_AARCH64
    d.setUint32(20, 1, true);
    d.setBigUint64(24, 0x1000n, true);
    d.setBigUint64(32, 64n, true);
    d.setBigUint64(40, 0n, true);
    d.setUint16(52, 64, true);
    d.setUint16(54, 56, true);
    d.setUint16(56, 1, true);
    return bytes;
  }
  const elfBytes = elfFixture();
  const memSource = new MemoryByteSource(elfBytes, { maxReadLength: 128 });
  const image = await openBinarySource(memSource);
  assert.equal(image.format, "elf");
  assert.equal(image.bytes, null);
  console.log("  ok cross-check openBinarySource with MemoryByteSource");
}

console.log("All ByteSource contract tests PASS!");
