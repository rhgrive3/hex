import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const READINESS = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/validation/phase8/readiness.json'), 'utf8'));

/**
 * The readiness matrix is the P8-0 deliverable that decides Phase 8's scope. A
 * capability left unclassified is how a phase discovers halfway through that it
 * is missing an upstream fact and invents a private heuristic instead
 * (PHASE8_FAST_PATH §3: no capability stays UNKNOWN).
 */
const REQUIRED_CAPABILITIES = Object.freeze([
  'semantic-ir', 'cfg', 'ssa', 'memory-ssa', 'alias-analysis', 'escape-analysis',
  'function-summaries-effects', 'range-value-facts', 'type-constraints',
  'debug-runtime-metadata', 'provenance', 'decompiler-pass-manager', 'rewrite-engine',
  'loop-recovery', 'switch-recovery', 'equivalence-verification',
  'artifact-store-versioning', 'cancellation-deadline', 'compiler-truth',
  'ghidra-differential', 'cross-binary-accuracy', 'architecture-neutrality',
  'copy-propagation', 'sccp', 'gvn-cse', 'load-store-forwarding', 'effect-aware-dce',
  'loop-induction', 'prototype-recovery', 'variable-coalescing',
  'tail-call-thunk-normalization', 'irreducible-exception-structuring',
  'aggregate-array-recovery', 'language-compiler-providers',
]);

test('every required middle-end capability has a row', () => {
  const present = new Set(READINESS.capabilities.map((capability) => capability.id));
  for (const required of REQUIRED_CAPABILITIES) {
    assert.ok(present.has(required), `readiness matrix is missing a required capability: ${required}`);
  }
});

test('every row has an allowed state, an owner where work remains, and a finding', () => {
  const allowed = new Set(READINESS.states);
  assert.ok(!allowed.has('UNKNOWN'), 'UNKNOWN must not be an allowed state');
  for (const capability of READINESS.capabilities) {
    assert.ok(allowed.has(capability.state), `${capability.id} has an unclassified state: ${capability.state}`);
    assert.ok(capability.finding && capability.finding.length > 20,
      `${capability.id} has no finding; a state without a reason is an opinion`);
    if (capability.state === 'PARTIAL_EXISTING' || capability.state === 'PHASE8_IMPLEMENT') {
      assert.ok(capability.owner, `${capability.id} needs work but names no owning checkpoint`);
    }
  }
});

test('every cited evidence path exists', () => {
  // A matrix that cites a file which was moved or deleted is a matrix that has
  // silently gone stale, which is the exact failure §5 of the Master
  // Architecture exists to prevent.
  for (const capability of READINESS.capabilities) {
    for (const evidence of capability.evidence ?? []) {
      assert.ok(fs.existsSync(path.join(ROOT, evidence)),
        `${capability.id} cites missing evidence: ${evidence}`);
    }
  }
});

test('a capability claimed PROVEN_EXISTING must cite evidence', () => {
  for (const capability of READINESS.capabilities) {
    if (capability.state !== 'PROVEN_EXISTING') continue;
    assert.ok((capability.evidence ?? []).length > 0,
      `${capability.id} is claimed proven with no evidence cited`);
  }
});

test('the matrix records the commit it was audited against', () => {
  assert.match(READINESS.auditedCommit, /^[0-9a-f]{40}$/);
});
