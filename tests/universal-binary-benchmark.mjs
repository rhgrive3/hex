import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { openBinarySource, auditBinary } from '../js/binary/index.js';
import { NodeFileByteSource } from '../js/bytesource/node.js';
import { InstrumentedByteSource } from '../js/bytesource/cached.js';
import { median, SCHEMA_VERSION } from '../tools/benchmark/schema.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(root, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'real-binaries.json'), 'utf8'));
const cliFiles = process.argv.slice(2);
const defaultRun = cliFiles.length === 0;
const sampleCount = Number(process.env.HEX_BENCHMARK_SAMPLES || 3);
if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 9) throw new Error('HEX_BENCHMARK_SAMPLES must be an integer from 1 to 9');
const files = defaultRun
  ? Object.entries(manifest.fixtures).map(([name, spec]) => ({ name, path: path.join(root, '.real-fixtures', spec.file), spec }))
  : cliFiles.map((file) => ({ name: path.basename(file), path: file, spec: null }));

async function digestFile(file) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest('hex') };
}

async function verifyPinnedFixture(target) {
  if (!target.spec) return null;
  if (!fs.existsSync(target.path)) throw new Error(`${target.name}: required fixture is missing at ${path.relative(repoRoot, target.path)}`);
  const digest = await digestFile(target.path);
  if (digest.size !== target.spec.size) throw new Error(`${target.name}: size mismatch (${digest.size} != ${target.spec.size})`);
  if (digest.sha256 !== target.spec.sha256) throw new Error(`${target.name}: SHA-256 mismatch`);
  return digest;
}

async function sample(file) {
  const nodeSource = await NodeFileByteSource.open(file, { maxReadLength: 8 * 1024 * 1024 });
  try {
    const source = new InstrumentedByteSource(nodeSource);
    const before = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const image = await openBinarySource(source, { ranges: { pageSize: 64 * 1024, maxPageSize: 2 * 1024 * 1024, maxCachedBytes: 16 * 1024 * 1024 } });
    const loaderMs = performance.now() - t0;
    const audit = auditBinary(image);
    const after = process.memoryUsage().heapUsed;
    const io = source.metrics();
    return {
      loaderMs: Number(loaderMs.toFixed(3)),
      heapDeltaMiB: Number(((after - before) / 1048576).toFixed(3)),
      work: {
        rangeReads: io.reads,
        totalRequestedBytes: io.totalRequested,
        largestSingleRead: io.largestSingleRead,
      },
      identity: {
        bytes: Number(nodeSource.size),
        format: image.format,
        arch: image.arch,
        sourceBacked: image.bytes === null,
        sections: image.sections.length,
        imports: image.imports.length,
        importSites: image.imports.reduce((n, x) => n + (x.sites?.length || 0), 0),
        functionSeeds: image.functions.length,
        symbols: image.symbols.length,
        exports: image.exports.length,
        auditErrors: audit.errors,
        auditWarnings: audit.warnings,
      },
    };
  } finally {
    await nodeSource.close();
  }
}

const report = {
  schema: SCHEMA_VERSION,
  kind: 'binary-benchmark',
  policy: {
    wallClock: 'informational',
    deterministicWork: 'blocking-compatible',
    note: 'Wall-clock and heap deltas are observations only. Regression gates use correctness plus deterministic I/O work units.',
  },
  samplesPerTarget: sampleCount,
  targets: {},
};

for (const target of files) {
  const fixtureDigest = await verifyPinnedFixture(target);
  if (!target.spec && !fs.existsSync(target.path)) throw new Error(`${target.name}: benchmark input is missing at ${target.path}`);
  const samples = [];
  for (let i = 0; i < sampleCount; i++) samples.push(await sample(target.path));
  const identity = samples[0].identity;
  for (const row of samples.slice(1)) {
    if (JSON.stringify(row.identity) !== JSON.stringify(identity)) throw new Error(`${target.name}: non-deterministic loader identity across benchmark samples`);
  }
  report.targets[target.name] = {
    fixture: fixtureDigest ? { size: fixtureDigest.size, sha256: fixtureDigest.sha256 } : { status: 'unverified-ad-hoc' },
    ...identity,
    timing: {
      loaderMs: { samples: samples.map((x) => x.loaderMs), median: Number(median(samples.map((x) => x.loaderMs)).toFixed(3)) },
      heapDeltaMiB: { samples: samples.map((x) => x.heapDeltaMiB), median: Number(median(samples.map((x) => x.heapDeltaMiB)).toFixed(3)) },
    },
    work: {
      rangeReads: median(samples.map((x) => x.work.rangeReads)),
      totalRequestedBytes: median(samples.map((x) => x.work.totalRequestedBytes)),
      largestSingleRead: Math.max(...samples.map((x) => x.work.largestSingleRead)),
      samples: samples.map((x) => x.work),
    },
  };
}

if (defaultRun && Object.keys(report.targets).length !== Object.keys(manifest.fixtures).length) {
  throw new Error('default benchmark did not run every pinned real fixture');
}

console.log(JSON.stringify(report, null, 2));
