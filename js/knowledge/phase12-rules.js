import { deepFreeze, stableDigest } from '../core/identity/index.js';
import { importPhase12Package } from '../phase12/package-envelope.js';
import { createResourceBudget } from '../phase12/resource-budget.js';

export const CAPABILITY_RULE_LANGUAGE_VERSION = 'hex-capability-rule-language-v1';
export const CAPABILITY_SCOPES = Object.freeze(['instruction', 'basic-block', 'function', 'module', 'runtime']);

function required(value, code) { const text = String(value ?? '').trim(); if (!text) throw new TypeError(code); return text; }
function list(value) { return [...new Set((Array.isArray(value) ? value : []).map(String).filter(Boolean))].sort(); }
function getPath(root, path) {
  let value = root;
  for (const part of String(path || '').split('.').filter(Boolean)) { if (value == null) return undefined; value = value[part]; }
  return value;
}
function stable(value) { return stableDigest(value); }

function validateExpression(expression, depth = 0) {
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) throw new TypeError('capability-rule-expression-invalid');
  if (depth > 32) throw new TypeError('capability-rule-expression-too-deep');
  const op = String(expression.op || '').trim();
  const allowed = new Set(['all', 'any', 'not', 'exists', 'equals', 'in', 'contains', 'gte', 'lte', 'gt', 'lt']);
  if (!allowed.has(op)) throw new TypeError(`capability-rule-op-unsupported:${op}`);
  if (['all', 'any'].includes(op)) {
    if (!Array.isArray(expression.args) || !expression.args.length) throw new TypeError('capability-rule-args-required');
    expression.args.forEach((item) => validateExpression(item, depth + 1));
  } else if (op === 'not') validateExpression(expression.arg, depth + 1);
  else {
    if (typeof expression.path !== 'string' || !expression.path.length) throw new TypeError('capability-rule-path-required');
    if (expression.path.includes('__proto__') || expression.path.includes('constructor')) throw new TypeError('capability-rule-path-forbidden');
    if (['equals', 'in', 'contains', 'gte', 'lte', 'gt', 'lt'].includes(op) && expression.value === undefined) throw new TypeError('capability-rule-value-required');
  }
  return true;
}

export function compileCapabilityRule(input = {}, options = {}) {
  const id = required(input.id, 'capability-rule-id-required');
  const version = required(input.version || '1', 'capability-rule-version-required');
  const scope = input.scope || 'function';
  if (!CAPABILITY_SCOPES.includes(scope)) throw new TypeError('capability-rule-scope-invalid');
  const expression = input.when || input.expression;
  validateExpression(expression);
  const compiled = {
    languageVersion: CAPABILITY_RULE_LANGUAGE_VERSION,
    id, version, scope,
    dependencies: list(input.dependencies),
    requiredFeatures: list(input.requiredFeatures),
    expression,
    capabilityId: required(input.capabilityId || id, 'capability-id-required'),
    allowPartial: input.allowPartial === true,
    packageContentHash: input.packageContentHash || options.packageContentHash || null,
  };
  return deepFreeze({ ...compiled, compiledId: `compiled-rule:${stable(compiled)}` });
}

function evaluateExpression(expression, features, budget) {
  if (!budget.consumeWork()) return { value: false, complete: false, reason: budget.stopped?.reason || 'budget' };
  const op = expression.op;
  if (op === 'all' || op === 'any') {
    const results = expression.args.map((item) => evaluateExpression(item, features, budget));
    const complete = results.every((item) => item.complete);
    return { value: op === 'all' ? results.every((item) => item.value) : results.some((item) => item.value), complete, reason: results.find((item) => !item.complete)?.reason || null };
  }
  if (op === 'not') { const result = evaluateExpression(expression.arg, features, budget); return { value: !result.value, complete: result.complete, reason: result.reason }; }
  const actual = getPath(features, expression.path);
  if (op === 'exists') return { value: actual !== undefined && actual !== null, complete: true, reason: null };
  const expected = expression.value;
  if (op === 'equals') return { value: stable(actual) === stable(expected), complete: true, reason: null };
  if (op === 'in') return { value: Array.isArray(expected) && expected.some((item) => stable(item) === stable(actual)), complete: true, reason: null };
  if (op === 'contains') return { value: Array.isArray(actual) ? actual.some((item) => stable(item) === stable(expected)) : typeof actual === 'string' && actual.includes(String(expected)), complete: true, reason: null };
  const left = Number(actual), right = Number(expected);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return { value: false, complete: true, reason: null };
  if (op === 'gte') return { value: left >= right, complete: true, reason: null };
  if (op === 'lte') return { value: left <= right, complete: true, reason: null };
  if (op === 'gt') return { value: left > right, complete: true, reason: null };
  return { value: left < right, complete: true, reason: null };
}

export function evaluateCapabilityRule(rule, snapshot = {}, options = {}) {
  const compiled = rule.compiledId ? rule : compileCapabilityRule(rule, options);
  const budget = options.budget || createResourceBudget({ maxWork: options.maxWork || 10_000, maxNodes: options.maxFeatureQueries || 10_000, signal: options.signal });
  const completeness = snapshot.completeness || snapshot.analysisCompleteness || 'complete';
  const partialUpstream = completeness !== 'complete' || snapshot.partial === true || snapshot.unknown === true;
  const features = snapshot.features || snapshot;
  const result = evaluateExpression(compiled.expression, features, budget);
  const assumptions = list([...(snapshot.assumptions || []), ...(partialUpstream ? ['upstream-analysis-incomplete'] : []), ...(result.reason ? [result.reason] : [])]);
  const evidenceIds = list(snapshot.evidenceIds || snapshot.evidence?.map?.((item) => item.id || item.ref || stable(item)));
  const verdict = !result.complete || partialUpstream ? 'partial' : result.value ? 'supported' : 'not-detected';
  return deepFreeze({
    id: `capability-fact:${stable({ rule: compiled.compiledId, snapshotId: snapshot.snapshotId || null, evidenceIds, verdict })}`,
    capabilityId: compiled.capabilityId, scope: compiled.scope, targetEntityIds: list(snapshot.targetEntityIds || [snapshot.entityId]).filter(Boolean),
    ruleId: compiled.id, ruleVersion: compiled.version, packageContentHash: compiled.packageContentHash,
    evidenceIds, contradictingEvidenceIds: list(snapshot.contradictingEvidenceIds), assumptions,
    completeness: verdict === 'supported' ? 'complete' : verdict,
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
  const out = [];
  for (const rule of ordered) {
    const result = evaluateCapabilityRule(rule, snapshot, options);
    out.push(result);
    if (result.budget.stopped) break;
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
