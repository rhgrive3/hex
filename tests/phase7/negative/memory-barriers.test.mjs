import assert from 'node:assert/strict';
import test from 'node:test';

import { reachingConcreteStore, reachingMemoryDefinition } from '../../../js/semantics/memoryssa/queries.js';
import { createPhase7AliasSolver } from '../../../js/analysis/alias/solver.js';
import { buildFixture } from '../corpus/fixtures.mjs';

const phase7Factory = ({ ir, cfg, ssa }) => createPhase7AliasSolver({ ir, cfg, ssa }).queryAlias;

function loadDefinitions(fixtureId, loadNodeId) {
  const built = buildFixture(fixtureId, { providerId: 'phase7', queryAliasFactory: phase7Factory });
  const uses = built.memorySsa.uses.filter((use) => use.sourceEntityId === loadNodeId);
  assert.ok(uses.length > 0, `no memory use found for ${loadNodeId}`);
  return { built, uses, definitions: uses.map((use) => reachingMemoryDefinition(built.memorySsa, use)) };
}

/**
 * The barrier floor protected by MIGRATION_GUARDRAILS. Phase 7 may make these
 * answers more precise; it may never make them disappear. Forwarding a load
 * across an unknown store is unsound even when the forwarded value happens to
 * match the fixture's output (§17.4).
 */
test('an unknown pointer store between a store and a load is a barrier', () => {
  const { built, uses, definitions } = loadDefinitions('unknown-store-barrier', 'node_ld');
  assert.ok(definitions.every((definition) => definition.kind !== 'memory-def'),
    `load was forwarded across an unknown store: ${definitions.map((d) => d.kind).join(',')}`);
  for (const use of uses) assert.equal(reachingConcreteStore(built.memorySsa, use), null);
});

test('an unknown call between a store and a load is a barrier', () => {
  const { built, uses, definitions } = loadDefinitions('unknown-call-barrier', 'node_ld');
  assert.ok(definitions.some((definition) => definition.kind === 'call-clobber'),
    `unknown call did not clobber: ${definitions.map((d) => d.kind).join(',')}`);
  for (const use of uses) assert.equal(reachingConcreteStore(built.memorySsa, use), null);
});

test('a fully known effect-free call is not a barrier', () => {
  // The mirror image: conservatism must be driven by missing evidence, not by
  // the mere presence of a call node. Otherwise precision never recovers.
  const { built, uses, definitions } = loadDefinitions('pure-call-no-barrier', 'node_ld');
  assert.ok(definitions.every((definition) => definition.kind === 'memory-def'),
    `a proven-pure call blocked the link: ${definitions.map((d) => d.kind).join(',')}`);
  for (const use of uses) {
    assert.equal(reachingConcreteStore(built.memorySsa, use)?.sourceEntityId, 'node_st_known');
  }
});

test('an exact same-slot store reaches its load', () => {
  const { built, uses, definitions } = loadDefinitions('stack-identical', 'node_ld');
  assert.ok(definitions.every((definition) => definition.kind === 'memory-def'));
  for (const use of uses) {
    assert.equal(reachingConcreteStore(built.memorySsa, use)?.sourceEntityId, 'node_st');
  }
});

test('wiring the Phase 7 solver into MemorySSA does not remove any barrier', () => {
  // The same fixtures under the conservative floor and under the Phase 7
  // solver must agree about every barrier. Precision may differ; safety may not.
  for (const [fixtureId, loadNodeId] of [['unknown-store-barrier', 'node_ld'], ['unknown-call-barrier', 'node_ld']]) {
    const floor = buildFixture(fixtureId, { providerId: 'none' });
    const phase7 = buildFixture(fixtureId, { providerId: 'phase7', queryAliasFactory: phase7Factory });
    for (const built of [floor, phase7]) {
      const uses = built.memorySsa.uses.filter((use) => use.sourceEntityId === loadNodeId);
      for (const use of uses) {
        assert.equal(reachingConcreteStore(built.memorySsa, use), null,
          `${fixtureId}: barrier lost under one of the alias providers`);
      }
    }
  }
});

test('every memory answer explains itself through the alias proof', () => {
  const built = buildFixture('unknown-store-barrier', { providerId: 'phase7', queryAliasFactory: phase7Factory });
  const use = built.memorySsa.uses.find((item) => item.sourceEntityId === 'node_ld');
  const definition = reachingMemoryDefinition(built.memorySsa, use);
  assert.ok(definition, 'a reaching definition must exist even when it is a clobber');
  assert.ok(use.aliasRelation, 'the use records the alias relation that produced it');
});
