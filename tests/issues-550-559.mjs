import assert from 'node:assert/strict';
import fs from 'node:fs';
import { deterministicAnswer } from '../js/agent/runtime.js';
import { StringCollectionBudget } from '../js/string-budget.js';
import { productDescriptor } from '../js/platform/product-descriptor.js';
import { ownerEvidence, summaryEvidenceStatus, provenanceStatus } from '../js/ui/evidence-model.js';
import { queryFunctions, queryStrings } from '../js/ui/explorer-index.js';
import { SymbolIndex } from '../js/symbols.js';
import '../js/worker-budget.js';

// #557: supported is not verified, and source verdict confidence caps output.
{
  const answer = deterministicAnswer({ best: { address: 1n, score: 99, semanticFacts: [{}], verification: { verdict: { status: 'supported', confidence: 0.61 } } }, evidence: [], missingEvidence: [] });
  const reason = answer.reasons.find((x) => x.kind === 'deterministic-verification');
  assert.equal(reason.verified, false);
  assert.equal(answer.reasons.some((x) => x.kind === 'runtime-supported' && x.verified === false), true);
  assert.equal(answer.confidence, 0.61);
  const confirmed = deterministicAnswer({ best: { address: 2n, score: 99, semanticFacts: [{}], verification: { verdict: { status: 'confirmed', confidence: 0.83 } } }, evidence: [], missingEvidence: [] });
  assert.equal(confirmed.reasons[1].verified, true);
  assert.equal(confirmed.confidence, 0.83);
}

// #559: ambiguous owners never become Confirmed; recovered-summary certainty is independent.
{
  const ambiguous = ownerEvidence({ ambiguous: true, owners: [{ className: 'A', sel: 'x' }, { className: 'B', sel: 'x' }] });
  assert.equal(ambiguous.status, 'likely');
  assert.equal(ambiguous.candidates.length, 2);
  assert.equal(ownerEvidence({ className: 'A', sel: 'x' }).status, 'confirmed');
  assert.equal(summaryEvidenceStatus({ summary: 'heuristic prose' }), 'likely');
  assert.equal(summaryEvidenceStatus({ summary: { text: 'fact', status: 'confirmed' } }), 'confirmed');
}

// #558: names/function starts keep provenance and manual rename is not Confirmed.
{
  const sym = new SymbolIndex({ addrs: new BigUint64Array([0x1000n]), kinds: new Uint8Array([0]), names: 'real', funcs: new BigUint64Array([0x1000n]), functionStartsExact: true });
  assert.equal(provenanceStatus(sym.functionEvidence(0x1000n)), 'confirmed');
  assert.equal(provenanceStatus(sym.nameEvidence(0x1000n)), 'confirmed');
  sym.rename(0x1000n, 'mine');
  assert.equal(provenanceStatus(sym.nameEvidence(0x1000n)), 'manual');
  sym.addFunctions([0x1100n], { source: 'heuristic', confidence: 0.55, confirmed: false });
  assert.equal(provenanceStatus(sym.functionEvidence(0x1100n)), 'likely');
}

// #553: result and estimated-heap budgets are global, not per-region.
{
  const b = new StringCollectionBudget({ inputBytes: 100, resultLimit: 2, estimatedHeapBytes: 1000 });
  assert.equal(b.requestBytes(80), 80);
  assert.equal(b.requestBytes(80), 20);
  assert.equal(b.accept('a'), true);
  assert.equal(b.accept('b'), true);
  assert.equal(b.accept('c'), false);
  assert.equal(b.truncationReason, 'result-budget');
}

// #552: one descriptor works for ELF/PE/Mach-O-style inputs without false Mach-O defaults.
{
  const elf = productDescriptor({ formatId: 'elf', productDescriptor: { formatId: 'elf', regions: [{ id: 'text' }], dependencies: ['libc.so.6'], imports: [{ library: 'libm.so.6' }], exports: [], formatMetadata: { arch: 'x86_64', bits: 64 } } }, null);
  assert.deepEqual(elf.dependencies, ['libc.so.6', 'libm.so.6']);
  assert.equal(elf.formatMetadata.arch, 'x86_64');
  assert.equal('hasCodeSignature' in elf.formatMetadata, false);
  const pe = productDescriptor({ formatId: 'pe', productDescriptor: { formatId: 'pe', regions: [], dependencies: ['KERNEL32.dll'], imports: [], exports: [], formatMetadata: { bits: 64 } } }, null);
  assert.deepEqual(pe.dependencies, ['KERNEL32.dll']);
  const macho = productDescriptor({ formatId: 'macho', slices: [{ info: { format: 'macho', dylibs: ['/usr/lib/libSystem.B.dylib'] }, regions: [] }] }, null);
  assert.deepEqual(macho.dependencies, ['/usr/lib/libSystem.B.dylib']);
}

// #550: indexed search is cancellable/top-N and no longer scans/materializes hundreds of thousands on each keystroke.
{
  const count = 25_000;
  const funcs = new BigUint64Array(count);
  const addrs = new BigUint64Array(count);
  const names = [];
  for (let i = 0; i < count; i++) { funcs[i] = 0x1000n + BigInt(i * 4); addrs[i] = funcs[i]; names.push(`Function_${i}`); }
  const sym = new SymbolIndex({ addrs, kinds: new Uint8Array(count), names: names.join('\n'), funcs, functionStartsExact: true });
  const app = { symbols: sym, codeRegion: () => ({ vmAddr: 0x1000n, size: BigInt(count * 4 + 4) }), store: { get: () => null } };
  const rows = await queryFunctions(app, 'Function_249', { limit: 10 });
  assert(rows.length <= 10 && rows.length > 0);
  const strings = Array.from({ length: 20_000 }, (_, i) => ({ text: `row-${i}`, addr: BigInt(i) }));
  const hits = await queryStrings(strings, 'row-199', { limit: 7 });
  assert(hits.length <= 7 && hits.length > 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => queryFunctions(app, 'not-found', { signal: controller.signal }), /aborted/i);
}

// #554/#555/#556 structural worker invariants: shared byte budget, counted transport,
// bounded candidate slots, and a single provenance implementation shared by both scans.
// Detailed control-flow behavior is tested by issue-556-address-provenance.mjs.
{
  const budget = globalThis.HexWorkerBudget;
  assert.equal(budget.withinProgramBudget(budget.PROGRAM_INDEX_BYTES - 1, 1), true);
  assert.equal(budget.withinProgramBudget(budget.PROGRAM_INDEX_BYTES, 1), false);
  const source = fs.readFileSync(new URL('../js/worker-legacy.js', import.meta.url), 'utf8');
  assert.match(source, /candidate-memory-budget/);
  assert.match(source, /callCount: nCalls/);
  assert.match(source, /refCount: nRefs/);
  assert.doesNotMatch(source, /callFrom\.slice\(0, nCalls\)/);
  assert.match(source, /importScripts\([^\n]*address-provenance\.js/);
  assert.ok((source.match(/AddressProvenance\.create\(/g) || []).length >= 2);
  assert.ok((source.match(/provenance\.enter\(pc\)/g) || []).length >= 2);
  assert.doesNotMatch(source, /function makeAddressProvenance\(/);
  assert.doesNotMatch(source, /function addressProvenanceBase\(/);
}

await import('./issue-843-ccmp-guard.mjs');
console.log('issues 550-559 regressions: ok');
