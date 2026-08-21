import assert from 'node:assert/strict';
import { compileCapabilityRule, compileCapabilityRules, evaluateCapabilityRule, evaluateCapabilityRules } from '../../../js/knowledge/phase12-rules.js';
import { createResourceBudget } from '../../../js/phase12/resource-budget.js';

const rule = compileCapabilityRule({ id: 'has-xor', version: '1', capabilityId: 'crypto.xor', scope: 'function', requiredFeatures: ['effects'], when: { op: 'all', args: [{ op: 'contains', path: 'effects', value: 'xor' }, { op: 'gte', path: 'loopCount', value: 1 }] } });
const positive = evaluateCapabilityRule(rule, { snapshotId: 'snap-a', entityId: 'fn-a', features: { effects: ['load', 'xor'], loopCount: 2 }, evidenceIds: ['ev-a'], completeness: 'complete' });
assert.equal(positive.verdict, 'supported');
assert.equal(positive.confirmed, false);
assert.deepEqual(positive.evidenceIds, ['ev-a']);
const nearMiss = evaluateCapabilityRule(rule, { snapshotId: 'snap-b', entityId: 'fn-b', features: { effects: ['load'], loopCount: 2 }, completeness: 'complete' });
assert.equal(nearMiss.verdict, 'not-detected');
const partial = evaluateCapabilityRule(rule, { snapshotId: 'snap-c', entityId: 'fn-c', features: { effects: ['xor'], loopCount: 2 }, completeness: 'partial' });
assert.equal(partial.verdict, 'partial');
assert.ok(partial.assumptions.includes('upstream-analysis-incomplete'));
const missingRequiredFeature = evaluateCapabilityRule(rule, { snapshotId: 'snap-d', entityId: 'fn-d', features: { loopCount: 2 }, completeness: 'complete' });
assert.equal(missingRequiredFeature.verdict, 'partial');
assert.ok(missingRequiredFeature.assumptions.includes('required-feature-missing:effects'));

const ordered = compileCapabilityRules([
  { id: 'root', version: '1', capabilityId: 'root', dependencies: ['base'], when: { op: 'exists', path: 'marker' } },
  { id: 'base', version: '1', capabilityId: 'base', when: { op: 'equals', path: 'marker', value: true } },
]);
assert.deepEqual(ordered.map((item) => item.id), ['base', 'root']);
const supportedChain = evaluateCapabilityRules(ordered, { features: { marker: true }, evidenceIds: ['ev-chain'] });
assert.equal(supportedChain.length, 2);
assert.equal(supportedChain[0].verdict, 'supported');
assert.equal(supportedChain[1].verdict, 'supported');
assert.deepEqual(supportedChain[1].dependencyRuleIds, ['base']);
const unsupportedChain = evaluateCapabilityRules(ordered, { features: { marker: false } });
assert.equal(unsupportedChain[0].verdict, 'not-detected');
assert.equal(unsupportedChain[1].verdict, 'not-detected');
assert.ok(unsupportedChain[1].assumptions.includes('dependency-not-supported:base'));

const dependencyOnly = compileCapabilityRule({ id: 'dependent', dependencies: ['base'], when: { op: 'exists', path: 'marker' } });
const missingDependency = evaluateCapabilityRule(dependencyOnly, { features: { marker: true } });
assert.equal(missingDependency.verdict, 'partial');
assert.ok(missingDependency.assumptions.includes('dependency-missing:base'));

const missingVsNull = compileCapabilityRule({ id: 'null-check', when: { op: 'equals', path: 'value', value: null } });
assert.equal(evaluateCapabilityRule(missingVsNull, { features: {} }).verdict, 'not-detected', 'missing path must not compare equal to null');
assert.equal(evaluateCapabilityRule(missingVsNull, { features: { value: null } }).verdict, 'supported');
assert.throws(() => compileCapabilityRule({ id: 'proto', when: { op: 'exists', path: 'prototype.polluted' } }), /path-forbidden/);
assert.throws(() => compileCapabilityRule({ id: 'bad-in', when: { op: 'in', path: 'value', value: 'not-an-array' } }), /in-value-array-required/);

const hugeArgs = Array.from({ length: 4 }, (_, index) => ({ op: 'exists', path: `v${index}` }));
assert.throws(() => compileCapabilityRule({ id: 'too-many', when: { op: 'all', args: hugeArgs } }, { maxExpressionArgs: 3 }), /args-too-many/);
const sharedBudget = createResourceBudget({ maxWork: 3, maxNodes: 3 });
const budgetRules = compileCapabilityRules([
  { id: 'b1', when: { op: 'exists', path: 'x' } },
  { id: 'b2', when: { op: 'exists', path: 'x' } },
  { id: 'b3', when: { op: 'exists', path: 'x' } },
  { id: 'b4', when: { op: 'exists', path: 'x' } },
]);
const budgetResults = evaluateCapabilityRules(budgetRules, { features: { x: true } }, { budget: sharedBudget });
assert.equal(budgetResults.length, 4);
assert.equal(budgetResults.at(-1).verdict, 'partial');
assert.equal(sharedBudget.stopped?.reason, 'resource-limit-work');

assert.throws(() => compileCapabilityRules([
  { id: 'a', dependencies: ['b'], when: { op: 'exists', path: 'x' } },
  { id: 'b', dependencies: ['a'], when: { op: 'exists', path: 'x' } },
]), /cycle/);
console.log('[phase12] deterministic capability-rule tests passed');
