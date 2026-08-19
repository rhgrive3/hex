import assert from 'node:assert/strict';
import test from 'node:test';

import { TypeConstraintGraph, certainConclusions } from '../../../js/analysis/types/graph.js';
import {
  DEBUG_IDENTITY_VERDICTS,
  applyDebugTypesToGraph,
  createDebugIdentity,
  debugFunctionEvidence,
  isAuthoritative,
} from '../../../js/analysis/debug/provider.js';
import { DwarfDebugInfoProvider, gnuDebugLinkCrc32, readBuildId } from '../../../js/analysis/debug/dwarf.js';
import { PdbDebugInfoProvider, parseMsf, parsePdbInfoStream } from '../../../js/analysis/debug/pdb.js';
import {
  collectDebugMetrics,
  dwarfImage,
  loadDwarfFixtures,
  loadPdbFixtures,
  pdbImage,
} from '../../../tools/validation/phase7/lanes/debug.mjs';

const dwarfFixtures = loadDwarfFixtures();
const pdbFixtures = loadPdbFixtures();
const dwarf5 = dwarfFixtures.variants.find((variant) => variant.name === 'dwarf5');
const dwarf4 = dwarfFixtures.variants.find((variant) => variant.name === 'dwarf4');
const splitDebug = dwarfFixtures.variants.find((variant) => variant.name === 'split-debug');
const pdbVariant = pdbFixtures.variants[0];

test('both required debug ecosystems go through the common boundary', () => {
  // DWARF working is not the phase. The verifier requires both, and both must
  // be identity-bound and fail closed (§11.1 step 6).
  const metrics = collectDebugMetrics();
  assert.equal(metrics.bothIdentityBound, true);
  assert.equal(metrics.bothFailClosed, true);
  assert.equal(metrics.authoritativeOnMismatch, 0,
    'a mismatched debug source produced authoritative facts');
  for (const ecosystem of ['dwarf', 'pdb']) {
    assert.ok(metrics.ecosystems[ecosystem].available, `missing ecosystem: ${ecosystem}`);
    assert.ok(metrics.ecosystems[ecosystem].hardConstraintsWhenMatched > 0,
      `${ecosystem} produced no facts even when identity matched`);
  }
});

test('filename equality is never accepted as identity', () => {
  assert.throws(() => createDebugIdentity({
    verdict: 'matched-authoritative', providerId: 'p', providerVersion: '1',
    method: 'filename', expected: 'a.pdb', observed: 'a.pdb',
  }), /filename-is-not-authority/);
});

test('a match must have compared two real identities', () => {
  assert.throws(() => createDebugIdentity({
    verdict: 'matched-authoritative', providerId: 'p', providerVersion: '1', method: 'gnu-build-id',
  }), /requires-compared-identities/);
  assert.throws(() => createDebugIdentity({
    verdict: 'matched-authoritative', providerId: 'p', providerVersion: '1',
    method: 'gnu-build-id', expected: 'a', observed: 'b',
  }), /requires-equal-identities/);
});

test('only matched verdicts carry authority', () => {
  for (const verdict of DEBUG_IDENTITY_VERDICTS) {
    const authoritative = ['matched-authoritative', 'matched-partial'].includes(verdict);
    const identity = createDebugIdentity({
      verdict, providerId: 'p', providerVersion: '1', method: 'gnu-build-id',
      ...(authoritative ? { expected: 'a', observed: 'a' } : {}),
    });
    assert.equal(isAuthoritative(identity), authoritative, verdict);
  }
});

test('DWARF 4 and DWARF 5 both parse from real compiler output', () => {
  const provider = new DwarfDebugInfoProvider();
  for (const variant of [dwarf4, dwarf5]) {
    const result = provider.probe(dwarfImage(variant));
    assert.equal(result.identity.verdict, 'matched-authoritative', variant.name);
    assert.equal(result.identity.method, 'gnu-build-id');
    assert.ok(result.counts.dies > 10, `${variant.name}: too few DIEs to be a real parse`);
    const functions = provider.symbols(result, {}).records.filter((record) => record.descriptor.isFunction);
    const names = functions.map((record) => record.name).sort();
    assert.deepEqual(names, ['add_point', 'scale'], variant.name);
    for (const record of functions) {
      assert.match(record.address, /^0x[0-9a-f]+$/);
      assert.ok(record.sizeBytes > 0, 'a function extent must come from DW_AT_high_pc');
    }
  }
});

test('DWARF recovers the declared source types', () => {
  const provider = new DwarfDebugInfoProvider();
  const result = provider.probe(dwarfImage(dwarf5));
  const byName = new Map(provider.types(result, {}).records.map((record) => [record.name, record.descriptor.claim.name]));
  assert.equal(byName.get('p'), 'struct Point *');
  assert.equal(byName.get('h'), 'handle_t');
  assert.equal(byName.get('v'), 'double');
  assert.equal(byName.get('counter'), 'int32_t');
});

test('a DWARF build-id mismatch fails closed', () => {
  const provider = new DwarfDebugInfoProvider();
  const result = provider.probe(dwarfImage(dwarf5, { buildId: 'deadbeef'.repeat(5) }));
  assert.equal(result.identity.verdict, 'identity-mismatch');
  assert.equal(result.authoritative, false);

  const graph = new TypeConstraintGraph({ snapshotId: 's' });
  const applied = applyDebugTypesToGraph(graph, result, provider.types(result, {}));
  assert.equal(applied.hard, 0, 'a mismatched DWARF file must not state hard facts');
  assert.ok(applied.soft > 0, 'it should still be visible as weak evidence');
  // And nothing it contributed may reach certainty.
  for (const entityId of graph.entityIds()) {
    assert.deepEqual(certainConclusions(graph.solveEntity(entityId)), []);
  }
});

test('a missing split-debug companion is an explicit state, not silence', () => {
  const provider = new DwarfDebugInfoProvider();
  const sections = {};
  for (const [name, encoded] of Object.entries(splitDebug.sections)) {
    sections[name] = new Uint8Array(Buffer.from(encoded, 'base64'));
  }
  // A stripped binary carrying a debug link but no build id, and no companion.
  const link = new Uint8Array([...Buffer.from('split.debug\0'), 0, 0x11, 0x22, 0x33, 0x44]);
  const result = provider.probe({
    identity: {}, debugSections: { '.gnu_debuglink': link }, snapshotId: 's',
  });
  assert.equal(result.identity.verdict, 'companion-missing');
  assert.equal(result.authoritative, false);
  assert.match(result.identity.detail, /companion/);
});

test('a supplied companion is verified by CRC, not by name', () => {
  const provider = new DwarfDebugInfoProvider();
  const companion = new Uint8Array([1, 2, 3, 4, 5]);
  const crc = gnuDebugLinkCrc32(companion);
  const linkFor = (value) => {
    const name = Buffer.from('split.debug\0');
    const padded = Buffer.alloc((name.length + 3) & ~3);
    name.copy(padded);
    const crcBytes = Buffer.alloc(4);
    crcBytes.writeUInt32LE(value >>> 0, 0);
    return new Uint8Array(Buffer.concat([padded, crcBytes]));
  };
  const good = provider.probe({ identity: {}, debugSections: { '.gnu_debuglink': linkFor(crc) }, companionBytes: companion });
  assert.equal(good.identity.verdict, 'matched-authoritative');
  const bad = provider.probe({ identity: {}, debugSections: { '.gnu_debuglink': linkFor(crc ^ 0xffff) }, companionBytes: companion });
  assert.equal(bad.identity.verdict, 'identity-mismatch');
});

test('a build id is read from the real note section', () => {
  const note = new Uint8Array(Buffer.from(dwarf5.sections['.note.gnu.build-id'], 'base64'));
  assert.equal(readBuildId(note), dwarf5.buildId);
  assert.equal(readBuildId(new Uint8Array(4)), null);
});

test('PDB identity comes from the CodeView GUID and age', () => {
  const provider = new PdbDebugInfoProvider();
  const result = provider.probe(pdbImage(pdbVariant));
  assert.equal(result.identity.verdict, 'matched-authoritative');
  assert.equal(result.identity.method, 'codeview-guid-age');
  assert.equal(result.identity.observed, `${pdbVariant.codeView.guid}/${pdbVariant.codeView.age}`);
});

test('the PDB container and info stream parse from a real linker output', () => {
  const bytes = new Uint8Array(Buffer.from(pdbVariant.pdb, 'base64'));
  const msf = parseMsf(bytes);
  assert.equal(msf.complete, true);
  assert.ok(msf.streams.length > 4);
  const info = parsePdbInfoStream(msf.streams[1].read());
  assert.equal(info.guid, pdbVariant.codeView.guid);
  assert.equal(info.age, pdbVariant.codeView.age);
});

test('PDB recovers function symbols with resolved addresses and extents', () => {
  const provider = new PdbDebugInfoProvider();
  const result = provider.probe(pdbImage(pdbVariant));
  const functions = provider.symbols(result, {}).records.filter((record) => record.descriptor.isFunction);
  const names = [...new Set(functions.map((record) => record.name))].sort();
  assert.deepEqual(names, ['add_point', 'mainCRTStartup', 'scale2']);
  const withExtent = functions.filter((record) => record.sizeBytes > 0);
  assert.ok(withExtent.length >= 3, 'procedure records must supply extents');
  for (const record of functions) assert.match(record.address, /^0x[0-9a-f]+$/);
});

test('PDB recovers aggregate layout from the TPI stream', () => {
  const provider = new PdbDebugInfoProvider();
  const result = provider.probe(pdbImage(pdbVariant));
  const point = provider.aggregates(result).find((aggregate) => aggregate.name === 'Point');
  assert.ok(point, 'the struct declared in the fixture source must be recovered');
  assert.equal(point.sizeBytes, 8);
  assert.deepEqual(point.members.map((member) => [member.name, member.offset]), [['x', 0], ['y', 4]]);
});

test('a PDB GUID mismatch fails closed', () => {
  const provider = new PdbDebugInfoProvider();
  const result = provider.probe(pdbImage(pdbVariant, { codeView: { guid: '11111111-2222-3333-4444-555555555555', age: 1 } }));
  assert.equal(result.identity.verdict, 'identity-mismatch');
  assert.equal(result.authoritative, false);
  const graph = new TypeConstraintGraph({ snapshotId: 's' });
  assert.equal(applyDebugTypesToGraph(graph, result, provider.types(result, {})).hard, 0);
});

test('a PDB age mismatch fails closed even when the GUID matches', () => {
  // Same build, different link: the age is what distinguishes them, and a
  // GUID-only comparison would apply stale types confidently.
  const provider = new PdbDebugInfoProvider();
  const result = provider.probe(pdbImage(pdbVariant, {
    codeView: { guid: pdbVariant.codeView.guid, age: pdbVariant.codeView.age + 1 },
  }));
  assert.equal(result.identity.verdict, 'identity-mismatch');
  assert.equal(result.authoritative, false);
});

test('a missing PDB is companion-missing, not unavailable', () => {
  const provider = new PdbDebugInfoProvider();
  const result = provider.probe({ identity: { codeView: pdbVariant.codeView }, pdbBytes: null });
  assert.equal(result.identity.verdict, 'companion-missing');
  assert.equal(result.status.stopReason, 'dependency-missing');
});

test('a truncated PDB is unsupported, not a partial match', () => {
  const provider = new PdbDebugInfoProvider();
  const bytes = new Uint8Array(Buffer.from(pdbVariant.pdb, 'base64')).subarray(0, 4096);
  const result = provider.probe({ identity: { codeView: pdbVariant.codeView }, pdbBytes: bytes });
  assert.ok(['unsupported', 'identity-unavailable'].includes(result.identity.verdict));
  assert.equal(result.authoritative, false);
});

test('malformed debug bytes stay bounded and fail closed', () => {
  const dwarf = new DwarfDebugInfoProvider();
  const noise = new Uint8Array(4096).map((_, index) => (index * 37) & 0xff);
  const result = dwarf.probe({ identity: { buildId: 'aa' }, debugSections: { debug_info: noise, debug_abbrev: noise } });
  assert.equal(result.authoritative, false);
  assert.notEqual(result.status.completeness, 'complete');

  const pdb = new PdbDebugInfoProvider();
  const pdbResult = pdb.probe({ identity: { codeView: pdbVariant.codeView }, pdbBytes: noise });
  assert.equal(pdbResult.authoritative, false);
});

test('providers page their output', () => {
  const provider = new DwarfDebugInfoProvider();
  const result = provider.probe(dwarfImage(dwarf5));
  const first = provider.symbols(result, { pageSize: 1 });
  assert.equal(first.records.length, 1);
  assert.ok(first.nextCursor != null && first.truncated);
  const second = provider.symbols(result, { pageSize: 1, cursor: first.nextCursor });
  assert.notEqual(second.records[0].entityId, first.records[0].entityId);
});

test('every debug record carries its provider and build provenance', () => {
  for (const [provider, image] of [
    [new DwarfDebugInfoProvider(), dwarfImage(dwarf5)],
    [new PdbDebugInfoProvider(), pdbImage(pdbVariant)],
  ]) {
    const result = provider.probe(image);
    for (const record of provider.symbols(result, {}).records) {
      assert.ok(record.providerId && record.providerVersion,
        'a debug fact that cannot name its provider cannot be invalidated correctly');
      assert.equal(record.buildIdentity, result.identity.observed);
    }
  }
});

test('debug function evidence is weak when identity did not match', () => {
  const provider = new DwarfDebugInfoProvider();
  const matched = provider.probe(dwarfImage(dwarf5));
  const mismatched = provider.probe(dwarfImage(dwarf5, { buildId: '0'.repeat(40) }));
  const strong = debugFunctionEvidence(matched, provider.symbols(matched, {}));
  const weak = debugFunctionEvidence(mismatched, provider.symbols(mismatched, {}));
  assert.ok(strong.every((item) => item.confidence === 'exact'));
  assert.ok(weak.every((item) => item.confidence === 'heuristic'));
});

test('cancellation stops a probe before it claims anything', () => {
  const controller = new AbortController();
  controller.abort();
  for (const [provider, image] of [
    [new DwarfDebugInfoProvider(), dwarfImage(dwarf5)],
    [new PdbDebugInfoProvider(), pdbImage(pdbVariant)],
  ]) {
    const result = provider.probe(image, { signal: controller.signal });
    assert.equal(result.authoritative, false);
    assert.equal(result.status.stopReason, 'cancelled');
  }
});
