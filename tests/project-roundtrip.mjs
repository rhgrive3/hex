import assert from 'node:assert/strict';
import {
  HEX_PROJECT_VERSION,
  ProjectFormatError,
  createHexProject,
  importHexProject,
  parseHexProject,
  serializeHexProject,
  tryParseHexProject,
} from '../js/project/index.js';

const project = createHexProject({
  binaryHash: 'fnv1a64:10:abc',
  binaryMetadata: { format: 'macho', base: 0x100000000n },
  userNames: [{ addr: 0x100001000n, name: 'PlayerData::addCoins' }],
  comments: [{ addr: 0x100001004n, text: 'confirmed' }],
  types: [{ addr: 0x100001000n, type: 'int64_t(int64_t)' }],
  structs: [{ name: 'PlayerData', fields: [] }],
  bookmarks: [{ addr: 0x100001000n }],
  patches: [{ addr: 0x100001008n, bytes: [0, 0, 0, 0] }],
  confirmedFindings: [{ id: 'coins' }],
  agentAnswers: [{ question: 'coins', answer: '...' }],
  evidence: [{ addr: 0x100001008n }],
  analysisSettings: { language: 'ja' },
  cacheReferences: ['summary'],
  navigation: { currentFunction: 0x100001000n, history: [{ addr: 0x100001000n }], lastQuery: 'coins' },
});
const serialized = serializeHexProject(project);
const roundtrip = parseHexProject(serialized);
assert.equal(roundtrip.binary.metadata.base, 0x100000000n);
assert.equal(roundtrip.navigation.currentFunction, 0x100001000n);
assert.equal(roundtrip.binary.embedded, false);

const future = JSON.stringify({ ...project, version: HEX_PROJECT_VERSION + 1 }, (_k, v) => typeof v === 'bigint' ? String(v) : v);
assert.equal(tryParseHexProject(future).ok, false);
assert.equal(tryParseHexProject('{broken').ok, false);

const marker = 'PlayerData::addCoins';
const markerOffset = serialized.indexOf(marker);
assert.notEqual(markerOffset, -1, 'malformed UTF-8 regression marker must exist');
const encoder = new TextEncoder();
const malformedUtf8 = new Uint8Array([
  ...encoder.encode(serialized.slice(0, markerOffset)),
  0xC3, 0x28,
  ...encoder.encode(serialized.slice(markerOffset + marker.length)),
]);
const rejectsInvalidUtf8 = (error) => (
  error instanceof ProjectFormatError
  && error.code === 'HEX_PROJECT_INVALID_UTF8'
);

assert.throws(() => parseHexProject(malformedUtf8), rejectsInvalidUtf8);
assert.throws(() => parseHexProject(malformedUtf8.buffer.slice(0)), rejectsInvalidUtf8);
await assert.rejects(importHexProject(new Blob([malformedUtf8])), rejectsInvalidUtf8);
assert.deepEqual(tryParseHexProject(malformedUtf8), {
  ok: false,
  error: 'project bytes are not valid UTF-8',
  code: 'HEX_PROJECT_INVALID_UTF8',
});

const unicodeProject = createHexProject({ comments: [{ text: '日本語🙂' }] });
const unicodeBytes = encoder.encode(serializeHexProject(unicodeProject));
assert.equal(parseHexProject(unicodeBytes).user.comments[0].text, '日本語🙂');
assert.equal((await importHexProject(new Blob([unicodeBytes]))).user.comments[0].text, '日本語🙂');

console.log('project-roundtrip: PASS');
