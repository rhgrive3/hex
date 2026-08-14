#!/usr/bin/env node
import { openBinarySource, auditBinary, capabilitiesOf } from '../js/binary/index.js';
import { NodeFileByteSource } from '../js/bytesource/node.js';
import { InstrumentedByteSource } from '../js/bytesource/cached.js';
import { hashByteSource } from '../js/platform/hash.js';

const args = process.argv.slice(2);
const file = args.find((x) => !x.startsWith('-'));
if (!file) {
  console.error('Usage: node tools/binary-inspect.mjs <file> [--json] [--hash]');
  process.exit(2);
}

const nodeSource = await NodeFileByteSource.open(file, { maxReadLength: 8 * 1024 * 1024 });
try {
  const source = new InstrumentedByteSource(nodeSource);
  const image = await openBinarySource(source, { ranges: { pageSize: 64 * 1024, maxCachedBytes: 16 * 1024 * 1024 } });
  const audit = auditBinary(image);
  const metrics = source.metrics();
  const result = {
    file,
    bytes: image.fileSize,
    summary: image.summary(),
    capabilities: capabilitiesOf(image),
    audit: { ok: audit.ok, errors: audit.errors, warnings: audit.warnings, issues: audit.issues.slice(0, 100) },
    io: metrics,
    libraries: image.libraries,
    importSample: image.imports.slice(0, 50),
    exportSample: image.exports.slice(0, 50),
    functionSample: image.functions.slice(0, 50),
  };
  if (args.includes('--hash')) result.contentHash = await hashByteSource(nodeSource, { chunkSize: 1024 * 1024 });
  const json = JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? '0x' + value.toString(16).toUpperCase() : value, 2);
  if (args.includes('--json')) console.log(json);
  else {
    const s = result.summary;
    console.log(`${file}`);
    console.log(`${s.format.toUpperCase()} ${s.arch} ${s.bits}-bit ${s.endian}-endian`);
    console.log(`sections ${s.sections} | functions ${s.functions} | imports ${s.imports} | exports ${s.exports} | symbols ${s.symbols}`);
    console.log(`range reads ${metrics.reads} | largest read ${metrics.largestSingleRead} bytes | audit ${audit.errors} errors / ${audit.warnings} warnings`);
    if (image.metadata.chainedFixups?.bindingSites != null) console.log(`Mach-O chained binding sites: ${image.metadata.chainedFixups.bindingSites}`);
    if (image.metadata.ehFrameHeader) console.log(`ELF unwind function seeds: ${image.metadata.ehFrameHeader.recoveredFunctions}/${image.metadata.ehFrameHeader.declaredFunctions}`);
    if (image.metadata.exceptionDirectory) console.log(`PE exception function seeds: ${image.metadata.exceptionDirectory.count}`);
  }
} finally {
  await nodeSource.close();
}
