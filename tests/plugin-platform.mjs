import assert from 'node:assert/strict';
import { PlatformPluginRegistry } from '../js/platform/plugin-api.js';

const plugins = new PlatformPluginRegistry();
plugins.registerFormat('test.elf', { detect: () => true });
plugins.registerArchitecture('test.arch', { instructionAlignment: 1 });
plugins.registerKnowledgeProvider('test.knowledge', { lookup: () => [] });
plugins.registerViewContribution('test.view', { render: () => null });
plugins.registerGoalProvider('test.goal', { goals: () => [] });
plugins.registerAnalyzer('test.good', { analyze: async () => ({ ok: true }) });
plugins.registerAnalyzer('test.bad', { analyze: async () => { throw new Error('plugin boom'); } });
const results = await plugins.runAnalyzers({ binary: { hash: 'abc' }, capability: { format: 'elf' } });
assert.equal(results.length, 2);
assert.equal(results.find((x) => x.id === 'test.good').ok, true);
assert.equal(results.find((x) => x.id === 'test.bad').isolated, true);
assert.equal(plugins.failures.length, 1);
console.log('plugin-platform: PASS');
