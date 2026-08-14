import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { openBinarySource, auditBinary } from '../js/binary/index.js';
import { NodeFileByteSource } from '../js/bytesource/node.js';
import { InstrumentedByteSource } from '../js/bytesource/cached.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const files = process.argv.slice(2).length ? process.argv.slice(2) : ['battlecats','TsumTsum','YWP'].map((x) => path.join(root, x));
const results = [];
for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const nodeSource = await NodeFileByteSource.open(file, { maxReadLength: 8 * 1024 * 1024 });
  try {
    const source = new InstrumentedByteSource(nodeSource);
    const before = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const image = await openBinarySource(source, { ranges: { pageSize: 64 * 1024, maxCachedBytes: 16 * 1024 * 1024 } });
    const loaderMs = performance.now() - t0;
    const audit = auditBinary(image);
    const after = process.memoryUsage().heapUsed;
    const io = source.metrics();
    results.push({
      file: path.basename(file), bytes: Number(nodeSource.size), format: image.format, arch: image.arch,
      loaderMs: Number(loaderMs.toFixed(2)), heapDeltaMiB: Number(((after - before) / 1048576).toFixed(2)),
      rangeReads: io.reads, totalRequestedBytes: io.totalRequested,
      peakRequestedRange: '0x' + io.peakRequestedRange.toString(16).toUpperCase(),
      largestSingleRead: io.largestSingleRead,
      sourceBacked: image.bytes === null,
      sections: image.sections.length, imports: image.imports.length,
      importSites: image.imports.reduce((n, x) => n + (x.sites?.length || 0), 0),
      functionSeeds: image.functions.length, symbols: image.symbols.length, exports: image.exports.length,
      auditErrors: audit.errors, auditWarnings: audit.warnings,
    });
  } finally {
    await nodeSource.close();
  }
}
console.log(JSON.stringify(results, null, 2));
