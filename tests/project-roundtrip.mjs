import assert from 'node:assert/strict';
import { HEX_PROJECT_VERSION, createHexProject, parseHexProject, serializeHexProject, tryParseHexProject } from '../js/project/index.js';

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
const roundtrip = parseHexProject(serializeHexProject(project));
assert.equal(roundtrip.binary.metadata.base, 0x100000000n);
assert.equal(roundtrip.navigation.currentFunction, 0x100001000n);
assert.equal(roundtrip.binary.embedded, false);

const future = JSON.stringify({ ...project, version: HEX_PROJECT_VERSION + 1 }, (_k, v) => typeof v === 'bigint' ? String(v) : v);
assert.equal(tryParseHexProject(future).ok, false);
assert.equal(tryParseHexProject('{broken').ok, false);
console.log('project-roundtrip: PASS');
