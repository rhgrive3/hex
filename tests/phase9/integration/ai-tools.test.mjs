import assert from 'node:assert/strict';
import test from 'node:test';

import { createHexToolRegistry } from '../../../js/ai/tools/registry.js';
import { AI_TOOL_NAMES } from '../../../js/ai/tools/names.js';

test('AI ToolRegistry registers Phase 9 solver verification tools with safe cache options', () => {
  const registry = createHexToolRegistry({ binaryIdentity: 'test_bin', analysisRevision: 'rev1' });

  assert.ok(registry.tools.has('verify_edge_feasibility'));
  assert.ok(registry.tools.has('verify_bounded_equivalence'));
  assert.ok(registry.tools.has('verify_patch_equivalence'));

  for (const name of ['verify_edge_feasibility', 'verify_bounded_equivalence', 'verify_patch_equivalence']) {
    assert.ok(AI_TOOL_NAMES.includes(name), `AI_TOOL_NAMES must include ${name}`);
    const tool = registry.tools.get(name);
    assert.equal(tool.verifier, true);
    assert.equal(tool.category, 'verification');
    assert.equal(tool.resultKind, 'symbolic-verification');
    // Safe proof cache options: storeResult true, deterministic false (or verifierFingerprint)
    assert.equal(tool.storeResult, true);
    assert.equal(tool.deterministic, false);
  }
});
