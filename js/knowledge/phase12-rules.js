import { deepFreeze, stableDigest } from '../core/identity/index.js';
import { importPhase12Package } from '../phase12/package-envelope.js';
import { createResourceBudget } from '../phase12/resource-budget.js';

export const CAPABILITY_RULE_LANGUAGE_VERSION = 'hex-capability-rule-language-v1';
export const CAPABILITY_SCOPES = Object.freeze(['instruction', 'basic-block', 'function', 'module', 'runtime']);
const FORBIDDEN_PATH_PARTS = new Set(['__proto__', 'prototype', 'constructor']);

function required(value, code) { const text = String(value ?? '').trim(); if (!text) throw new TypeError(code); return text; }
function list(value) { return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))].sort(); }
function getPath(root, path) {
  let value = root;
  for (const part of String(path || '').split('.').filter(Boolean)) {
    if (FORBIDDEN_PATH_PARTS.has(part)) return undefined;
    if (value == null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    if (!Object.prototype.hasOwnProperty.call(value, part)) return undefined;
    value = value[part];
  }
  return value;
}
function stable(value) { return stableDigest(value); }
function safePositive(value, fallback, max, code) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new TypeError(code);
  return n;
}

function validateExpression(expression, depth, state) {
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) throw new TypeError('capability-rule-expression-invalid');
  if (depth > 32) throw new TypeError('capability-rule-expression-too-deep');
  state.nodes += 1;
  if (state.nodes > state.maxNodes) throw new TypeError('capability-rule-expression-too-large');
  const op = String(expression.op || '').trim();
  const allowed = new Set(['all', 'any', 'not', 'exists', 'equals', 'in', 'contains', 'gte', 'lte', 'gt', 'lt']);
  if (!allowed.has(op)) throw new TypeError(`capability-rule-op-unsupported:${op}`);
  if (['all', 'any'].includes(op)) {
    if (!Array.isArray(expression.args) || !expression.args.length) throw new TypeError('capability-rule-args-required');
    if (expression.args.length > state.maxArgs) throw new TypeError('capability-rule-args-too-many');
    expression.args.forEach((item) => validateExpression(item, depth + 1, state));
  } else if (op === 'not') {
    validateExpression(expression.arg, depth + 1, state);
  } else {
    if (typeof expression.path !== 'string' || !expression.path.length) throw new TypeError('capability-rule-path-required');
    const parts = expression.path.split('.').filter(Boolean);
    if (!parts.length || parts.some((part) => FORBIDDEN_PATH_PARTS.has(part))) throw new TypeError('capability-rule-path-forbidden');
    if (['equals', 'in', 'contains', 'gte', 'lte', 'gt', 'lt'].includes(op) && expression.value === undefined) throw new TypeError('capability-rule-value-required');
    if (op === 'in' && !Array.isArray(expression.value)) throw new TypeError('capability-rule-in-value-array-required');
  }
  return true;
}

export function compileCapabilityRule(input = {}, options = {}) {
  const id = required(input.id, 'capability-rule-id-required');
  const version = required(input.version || '1', 'capability-rule-version-required');
  const scope = input.scope || 'function';
  if (!CAPABILITY_SCOPES.includes(scope)) throw new TypeError('capability-rule-scope-invalid');
  const expression = input.when || input.expression;
  const expressionState = {
    nodes: 0,
    maxNodes: safePositive(options.maxExpressionNodes, 4096, 100_000, 'capability-rule-expression-node-limit-invalid'),
    maxArgs: safePositive(options.maxExpressionArgs, 1024, 10_000, 'capability-rule-expression-arg-limit-invalid'),
  };
  validateExpression(expression, 0, expressionState);
  const compiled = {
    languageVersion: CAPABILITY_RULE_LANGUAGE_VERSION,
    id, version, scope,
    dependencies: list(input.dependencies),
    requiredFeatures: list(input.requiredFeatures),
    expression,
    expressionNodeCount: expressionState.nodes,
    capabilityId: required(input.capabilityId || id, 'capability-id-required'),
    allowPartial: input.allowPartial === true,
    packageContentHash: input.packageContentHash || options.packageContentHash || null,
  };
  return deepFreeze({ ...compiled, compiledId: `compiled-rule:${stable(compiled)}` });
}

function numericValue(value) {
  if (typeof value === 'bigint') return { kind: 'bigint', value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) return null;
    return { kind: 'number', value };
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^-?\d+$/.test(text)) {
      try { return { kind: 'bigint', value: BigInt(text) }; } catch { return null; }
    }
    const n = Number(text);
    if (Number.isFinite(n)) return { kind: 'number', value: n };
  }
  return null;
}

function compareNumeric(leftValue, rightValue) {
  const left = numericValue(leftValue), right = numericValue(rightValue);
  if (!left || !right) return null;
  if (left.kind === 'bigint' && right.kind === 'bigint') return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
  if (left.kind === 'bigint' && right.kind === 'number') {
    if (!Number.isSafeInteger(right.value)) return null;
    const converted = BigInt(right.value);
    return left.value < converted ? -1 : left.value > converted ? 1 : 0;
  }
  if (left.kind === 'number' && right.kind === 'bigint') {
    if (!Number.isSafeInteger(left.value)) return null;
    const converted = BigInt(left.value);
    return converted < right.value ? -1 : converted > right.value ? 1 : 0;
  }
  return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
}

function evaluateExpression(expression, features, budget) {
  if (!budget.consumeWork()) return { value: false, complete: false, reason: budget.stopped?.reason || 'budget' };
  if (!budget.consumeNodes()) return { value: false, complete: false, reason: budget.stopped?.reason || 'budget' };
  const op = expression.op;
  if (op === 'all' || op === 'any') {
    const results = [];
    for (const item of expression.args) {
      results.push(evaluateExpression(item, features, budget));
      if (budget.stopped) break;
    }
    const complete = results.length === expression.args.length && results.every((item) => item.complete);
    return { value: op === 'all' ? results.length === expression.args.length && results.every((item) => item.value) : results.some((item) => item.value), complete, reason: results.find((item) => !item.complete)?.reason || budget.stopped?.reason || null };
  }
  if (op === 'not') { const result = evaluateExpression(expression.arg, features, budget); return { value: !result.value, complete: result.complete, reason: result.reason }; }
  const actual = getPath(features, expression.path);
  if (op === 'exists') return { value: actual !== undefined && actual !== null, complete: true, reason: null };
  if (actual === undefined) return { value: false, complete: true, reason: null };
  const expected = expression.value;
  if (op === 'equals') return { value: stable(actual) === stable(expected), complete: true, reason: null };
  if (op === 'in') return { value: expected.some((item) => stable(item) === stable(actual)), complete: true, reason: null };
  if (op === 'contains') return { value: Array.isArray(actual) ? actual.some((item) => stable(item) === stable(expected)) : typeof actual === 'string' && actual.includes(String(expected)), complete: true, reason: null };
  const compared = compareNumeric(actual, expected);
  if (compared == null) return { value: false, complete: true, reason: null };
  if (op === 'gte') return { value: compared >= 0, complete: true, reason: null };
  if (op === 'lte') return { value: compared <= 0, complete: true, reason: null };
  if (op === 'gt') return { value: compared > 0, complete: true, reason: null };
  return { value: compared < 0, complete: true, reason: null };
}

function dependencyMap(value) {
  if (value instanceof Map) return value;
  if (!value || typeof value !== 'object') return new Map();
  return new Map(Object.entries(value));
}

export function evaluateCapabilityRule(rule, snapshot = {}, options = {}) {
  const compiled = rule.compiledId ? rule : compileCapabilityRule(rule, options);
  const budget = options.budget || createResourceBudget({ maxWork: options.maxWork || 10_000, maxNodes: options.maxFeatureQueries || 10_000, signal: options.signal });
  const completeness = snapshot.completeness || snapshot.analysisCompleteness || 'complete';
  const partialUpstream = completeness !== 'complete' || snapshot.partial === true || snapshot.unknown === true;
  const features = snapshot.features || snapshot;
  const dependencies = dependencyMap(options.dependencyResults);
  const dependencyResults = compiled.dependencies.map((id) => ({ id, result: dependencies.get(id) || null }));
  const missingDependencies = dependencyResults.filter((item) => !item.result).map((item) => item.id);
  const partialDependencies = dependencyResults.filter((item) => item.result?.verdict === 'partial').map((item) => item.id);
  const unsatisfiedDependencies = dependencyResults.filter((item) => item.result && item.result.verdict !== 'supported' && item.result.verdict !== 'partial').map((item) => item.id);
  const missingFeatures = compiled.requiredFeatures.filter((feature) => getPath(features, feature) === undefined);
  const dependencyEvidenceIds = dependencyResults.flatMap((item) => item.result?.evidenceIds || []);
  const dependencyIncomplete = missingDependencies.length > 0 || partialDependencies.length > 0;

  const result = dependencyIncomplete || missingFeatures.length
    ? { value: false, complete: false, reason: dependencyIncomplete ? 'capability-rule-dependency-incomplete' : 'capability-rule-required-feature-missing' }
    : unsatisfiedDependencies.length
      ? { value: false, complete: true, reason: 'capability-rule-dependency-not-supported' }
      : evaluateExpression(compiled.expression, features, budget);

  const assumptions = list([
    ...(snapshot.assumptions || []),
    ...(partialUpstream ? ['upstream-analysis-incomplete'] : []),
    ...missingDependencies.map((id) => `dependency-missing:${id}`),
    ...partialDependencies.map((id) => `dependency-partial:${id}`),
    ...unsatisfiedDependencies.map((id) => `dependency-not-supported:${id}`),
    ...missingFeatures.map((feature) => `required-feature-missing:${feature}`),
    ...(result.reason ? [result.reason] : []),
  ]);
  const evidenceIds = list([...(snapshot.evidenceIds || snapshot.evidence?.map?.((item) => item.id || item.ref || stable(item)) || []), ...dependencyEvidenceIds]);
  const verdict = !result.complete || partialUpstream ? 'partial' : result.value ? 'supported' : 'not-detected';
  return deepFreeze({
    id: `capability-fact:${stable({ rule: compiled.compiledId, snapshotId: snapshot.snapshotId || null, evidenceIds, verdict })}`,
    capabilityId: compiled.capabilityId, scope: compiled.scope, targetEntityIds: list(snapshot.targetEntityIds || [snapshot.entityId]).filter(Boolean),
    ruleId: compiled.id, ruleVersion: compiled.version, packageContentHash: compiled.packageContentHash,
    dependencyRuleIds: Object.freeze([...compiled.dependencies]), requiredFeatures: Object.freeze([...compiled.requiredFeatures]),
    evidenceIds, contradictingEvidenceIds: list(snapshot.contradictingEvidenceIds), assumptions,
    completeness: verdict === 'supported' || verdict === 'not-detected' ? 'complete' : 'partial',
    verdict, confirmed: false, authority: 'L2-evidence', budget: budget.snapshot(),
  });
}

export function compileCapabilityRules(rules = [], options = {}) {
  const compiled = new Map();
  for (const rule of rules) {
    const item = compileCapabilityRule(rule, options);
    if (compiled.has(item.id)) throw new TypeError(`capability-rule-duplicate:${item.id}`);
    compiled.set(item.id, item);
  }
  const visiting = new Set(), visited = new Set(), ordered = [];
  function visit(id, depth = 0) {
    if (depth > 64) throw new TypeError('capability-rule-dependency-depth-exceeded');
    if (visiting.has(id)) throw new TypeError(`capability-rule-dependency-cycle:${id}`);
    if (visited.has(id)) return;
    const rule = compiled.get(id);
    if (!rule) throw new TypeError(`capability-rule-dependency-missing:${id}`);
    visiting.add(id);
    for (const dependency of rule.dependencies) visit(dependency, depth + 1);
    visiting.delete(id); visited.add(id); ordered.push(rule);
  }
  for (const id of [...compiled.keys()].sort()) visit(id);
  return Object.freeze(ordered);
}

export function evaluateCapabilityRules(rules, snapshot, options = {}) {
  const ordered = Array.isArray(rules) && rules.every((rule) => rule.compiledId) ? rules : compileCapabilityRules(rules, options);
  const budget = options.budget || createResourceBudget({ maxWork: options.maxWork || 10_000, maxNodes: options.maxFeatureQueries || 10_000, signal: options.signal });
  const resultsById = new Map();
  const out = [];
  for (const rule of ordered) {
    const result = evaluateCapabilityRule(rule, snapshot, { ...options, budget, dependencyResults: resultsById });
    out.push(result);
    resultsById.set(rule.id, result);
    if (budget.stopped) break;
  }
  return Object.freeze(out);
}

export function importCapabilityRulePackage(value, options = {}) {
  const envelope = importPhase12Package(value, options);
  if (!['capability-rules', 'mixed'].includes(envelope.kind)) throw new TypeError('capability rule package kind required');
  const rules = envelope.payload.rules || envelope.payload;
  if (!Array.isArray(rules)) throw new TypeError('capability rule package payload must contain rules');
  return Object.freeze({ envelope, rules: compileCapabilityRules(rules, { ...options, packageContentHash: envelope.contentHash }) });
}
