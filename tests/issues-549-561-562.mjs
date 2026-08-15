import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SymbolIndex } from '../js/symbols.js';
import { ProgramIndex } from '../js/program.js';

// #549: structured names preserve control characters and Unicode byte-for-byte
// at the JS string boundary, without shifting subsequent address/name pairs.
{
  const names = ['foo\nbar', 'carriage\rreturn', 'tab\tname', '日本語', '', 'x'.repeat(8192)];
  const addrs = new BigUint64Array(names.map((_, i) => 0x1000n + BigInt(i * 4)));
  const kinds = new Uint8Array(names.length);
  const flags = new Uint8Array(names.length);
  const index = new SymbolIndex({ addrs, kinds, flags, names });
  assert.equal(index.symbolTransportValid, true);
  assert.equal(index.symbolCount, names.length);
  names.forEach((name, i) => assert.equal(index.exact(addrs[i])?.name, name));
}

// A malformed cardinality is identity corruption, so symbol naming fails closed
// while independent function starts remain usable.
{
  const funcs = new BigUint64Array([0x2000n]);
  const index = new SymbolIndex({
    addrs: new BigUint64Array([0x1000n, 0x1004n]),
    names: ['only-one'],
    kinds: new Uint8Array(2),
    flags: new Uint8Array(2),
    funcs,
  });
  assert.equal(index.symbolTransportValid, false);
  assert.equal(index.symbolTransportError, 'symbol-cardinality-mismatch');
  assert.equal(index.symbolCount, 0);
  assert.equal(index.functionCount, 1);
}

// Legacy delimiter strings remain readable for persisted/test callers, but the
// actual worker producers must no longer emit them.
{
  const index = new SymbolIndex({
    addrs: new BigUint64Array([1n, 2n]),
    kinds: new Uint8Array(2), flags: new Uint8Array(2), names: 'a\nb',
  });
  assert.equal(index.symbolTransportValid, true);
  assert.equal(index.nameAt(1n), 'a');
  assert.equal(index.nameAt(2n), 'b');
}

const platformWorker = fs.readFileSync(new URL('../js/platform/worker.js', import.meta.url), 'utf8');
const legacyWorker = fs.readFileSync(new URL('../js/worker-legacy.js', import.meta.url), 'utf8');
const chained = fs.readFileSync(new URL('../js/chained.js', import.meta.url), 'utf8');
assert.match(platformWorker, /names:\s*sorted\.map\(\(x\) => String\(x\.name \?\? ''\)\)/);
assert.doesNotMatch(platformWorker, /names:\s*sorted\.map\([^\n]+\.join\('\\n'\)/);
assert.match(legacyWorker, /names:\s*names\.slice\(0, n\)\.map/);
assert.match(chained, /Object\.assign\(\{\}, result, \{ addrs, kinds, flags, names \}\)/);

// #561: unsupported program scanning is unavailable evidence, not complete-empty.
{
  const empty = {
    callFrom: new BigUint64Array(0), callTo: new BigUint64Array(0),
    refFrom: new BigUint64Array(0), refTo: new BigUint64Array(0),
    refKind: new Uint8Array(0), kinds: new Uint8Array(0),
    kindsCovered: 0, words: 0, callsCapped: false, refsCapped: false,
  };
  const unsupported = new ProgramIndex({
    ...empty, unsupported: true, architecture: 'x86_64',
    completeness: { complete: false, reasons: ['unsupported-program-analysis'] },
  }, null, { vmAddr: 0n, size: 0n });
  assert.equal(unsupported.unsupported, true);
  assert.equal(unsupported.graphCompleteness.supported, false);
  assert.equal(unsupported.graphCompleteness.callsComplete, false);
  assert.equal(unsupported.graphCompleteness.refsComplete, false);
  assert.equal(unsupported.graphCompleteness.statsComplete, false);
  assert.equal(unsupported.graphCompleteness.architecture, 'x86_64');
  const callers = unsupported.callersOf(0x1000n);
  assert.equal(callers.complete, false);
  assert.equal(callers.unsupported, true);
  assert.equal(callers.incompleteReason, 'unsupported-program-analysis');
  const refs = unsupported.functionsReferencing(0x1000n);
  assert.equal(refs.complete, false);
  assert.equal(refs.incompleteReason, 'unsupported-program-analysis');
  const stats = unsupported.statsOf(0n, 4n);
  assert.equal(stats.covered, false);
  assert.equal(stats.unsupported, true);

  const supportedEmpty = new ProgramIndex(empty, null, { vmAddr: 0n, size: 0n });
  assert.equal(supportedEmpty.unsupported, false);
  assert.equal(supportedEmpty.graphCompleteness.callsComplete, true);
  assert.equal(supportedEmpty.graphCompleteness.refsComplete, true);
  assert.equal(supportedEmpty.graphCompleteness.statsComplete, true);
}

// #562: an exact subset is not an exhaustive function list.
{
  const partial = new SymbolIndex({
    funcs: new BigUint64Array([0x3000n, 0x4000n]),
    names: [], addrs: new BigUint64Array(0),
    allSeedsExact: true, discoveryComplete: false, functionStartsExact: false,
    functionDiscovery: { complete: false, reasons: ['partial-exact-seeds'] },
  });
  assert.equal(partial.allSeedsExact, true);
  assert.equal(partial.functionStartsComplete, false);
  assert.equal(partial.functionStartsExact, false);

  const authoritative = new SymbolIndex({
    funcs: new BigUint64Array([0x3000n]), names: [], addrs: new BigUint64Array(0),
    functionStartsExact: true,
  });
  assert.equal(authoritative.functionStartsComplete, true);
  assert.equal(authoritative.functionStartsExact, true);
}

const appSource = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
assert.match(appSource, /sym\.functionStartsComplete\s*===\s*true\s*\|\|\s*sym\.functionDiscovery\?\.complete\s*===\s*true/);
assert.doesNotMatch(appSource, /if\s*\(\s*!sym\s*\|\|\s*sym\.functionStartsExact\s*\)/);
assert.match(platformWorker, /allSeedsExact/);
assert.match(platformWorker, /discoveryComplete/);

console.log('issues #549/#561/#562 regressions passed');