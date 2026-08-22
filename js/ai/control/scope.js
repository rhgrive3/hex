import { AIError } from '../schema.js';
import { addressText } from '../validation.js';

export const SCOPE_ORDER = Object.freeze(['selection', 'function', 'neighborhood', 'binary', 'project', 'runtime']);
const RANK = Object.freeze(Object.fromEntries(SCOPE_ORDER.map((scope, index) => [scope, index])));
const FULL_FUNCTION_TOOLS = new Set(['get_function','get_current_function','get_semantic_facts','decompile_function','get_cfg','trace_value','slice_backward','slice_forward','find_thresholds','verify_field_update','find_field_reads','find_field_writes','find_global_accesses']);
const BINARY_TOOLS = new Set(['search_functions','search_strings','compare_functions','lookup_known_function']);
const PROJECT_TOOLS = new Set(['project_search','get_binary_diff']);
const RUNTIME_TOOLS = new Set(['get_runtime_observations','verify_runtime_hypothesis']);

export class ScopeController {
  constructor(snapshot, requestedScope = 'auto', { onExpand } = {}) {
    this.snapshot = snapshot;
    this.requestedScope = requestedScope || 'auto';
    this.effectiveScope = this.requestedScope === 'auto' ? initialScope(snapshot) : this.requestedScope;
    this.onExpand = onExpand || null;
    this.expansions = [];
  }

  expandTo(next, reason = 'required evidence') {
    if (this.requestedScope !== 'auto') return false;
    if (!(next in RANK) || RANK[next] <= (RANK[this.effectiveScope] ?? -1)) return false;
    const event = {
      type: 'scope-expand', from: this.effectiveScope, to: next,
      label: `解析範囲を ${this.effectiveScope} から ${next} へ拡張`, reason: String(reason).slice(0, 300),
      timestamp: new Date().toISOString(),
    };
    this.effectiveScope = next;
    this.expansions.push(event);
    this.onExpand?.(event);
    return true;
  }

  ensureForIntent(intent) {
    const target = scopeForIntent(intent, this.snapshot);
    if (target) this.expandTo(target, `intent:${intent}`);
    return this.effectiveScope;
  }

  scopeAllowsTool(scope = this.effectiveScope, tool, args = {}) {
    const effective = scope === 'auto' ? this.effectiveScope : scope;
    if (effective === 'selection' && FULL_FUNCTION_TOOLS.has(tool)) return false;
    if (BINARY_TOOLS.has(tool) && !atLeast(effective, 'binary')) return false;
    if (PROJECT_TOOLS.has(tool) && effective !== 'project') return false;
    if (RUNTIME_TOOLS.has(tool) && effective !== 'runtime') return false;
    if (effective === 'function' || effective === 'selection' || effective === 'neighborhood') {
      for (const address of collectAddresses(args)) if (!this.scopeContainsAddress(effective, address)) return false;
    }
    return true;
  }

  scopeContainsAddress(scope = this.effectiveScope, address) {
    const effective = scope === 'auto' ? this.effectiveScope : scope;
    if (['binary','project','runtime'].includes(effective)) return true;
    const target = toBigInt(address);
    if (target == null) return false;
    if (effective === 'selection') return inRange(target, this.snapshot.selection?.start, this.snapshot.selection?.end);
    if (effective === 'function') return inFunction(target, this.snapshot.currentFunction);
    if (effective === 'neighborhood') {
      if (inFunction(target, this.snapshot.currentFunction)) return true;
      return (this.snapshot.neighborhood || []).some((item) => sameAddress(item, target));
    }
    return false;
  }

  scopeContainsFunction(scope = this.effectiveScope, address) {
    const effective = scope === 'auto' ? this.effectiveScope : scope;
    if (effective === 'selection') return false;
    if (['binary','project','runtime'].includes(effective)) return true;
    if (sameAddress(this.snapshot.currentFunction?.address, address)) return true;
    return effective === 'neighborhood' && (this.snapshot.neighborhood || []).some((item) => sameAddress(item, address));
  }

  assertToolCall(tool, args = {}) {
    if (!this.scopeAllowsTool(this.effectiveScope, tool, args)) throw new AIError('scope_violation', `${tool} is outside ${this.effectiveScope} scope.`);
    for (const address of collectAddresses(args)) {
      if (!this.scopeContainsAddress(this.effectiveScope, address)) throw new AIError('scope_violation', `Address ${addressText(address)} is outside ${this.effectiveScope} scope.`);
    }
  }
}

export function initialScope(snapshot) {
  if (snapshot?.selection?.start) return 'selection';
  if (snapshot?.currentFunction?.address) return 'function';
  return snapshot?.projectIdentity && !snapshot?.binaryId ? 'project' : 'binary';
}

export function scopeForIntent(intent, snapshot = {}) {
  if (intent === 'find-behaviour' || intent === 'find-function') return 'binary';
  if (intent === 'project-query') return 'project';
  if (intent === 'runtime-verify') return 'runtime';
  if (intent === 'compare') return 'binary';
  if (intent === 'explain-selection') return snapshot.selection ? 'selection' : 'function';
  if (intent === 'explain-current-function' || intent === 'trace-value') return 'function';
  return null;
}

export function scopeContainsAddress(snapshot, scope, address) { return new ScopeController(snapshot, scope).scopeContainsAddress(scope, address); }
export function scopeContainsFunction(snapshot, scope, address) { return new ScopeController(snapshot, scope).scopeContainsFunction(scope, address); }
export function scopeAllowsTool(snapshot, scope, tool, args) { return new ScopeController(snapshot, scope).scopeAllowsTool(scope, tool, args); }

function atLeast(scope, minimum) { return (RANK[scope] ?? -1) >= RANK[minimum]; }
function collectAddresses(value, key = '') {
  const out = [];
  if (Array.isArray(value)) { for (const item of value) out.push(...collectAddresses(item, key)); return out; }
  if (!value || typeof value !== 'object') { if (isAddressKey(key) && toBigInt(value) != null) out.push(value); return out; }
  for (const [childKey, child] of Object.entries(value)) out.push(...collectAddresses(child, childKey));
  return out;
}
function isAddressKey(key) {
  const text = String(key || '');
  return /^(address|addr|start|end|from|to|target)$/i.test(text)
    || /_(address|addr|start|end|from|to|target)$/i.test(text)
    || /(Address|Addr|Start|End|From|To|Target)$/.test(text);
}
function inFunction(target, fn) {
  if (!fn?.address) return false;
  const start = toBigInt(fn.range?.start ?? fn.address);
  const endExclusive = toBigInt(fn.range?.end);
  if (start == null) return false;
  // Hex function ranges (SymbolIndex.functionAt / ProgramIndex) use an
  // exclusive end. Treating it as inclusive admits the next function's first
  // address into scope=function.
  if (endExclusive != null) return target >= start && target < endExclusive;
  return target === start;
}
function inRange(target, start, end) {
  const a = toBigInt(start), b = toBigInt(end);
  if (a == null) return false;
  if (b == null) return target === a;
  return target >= a && target <= b;
}
function sameAddress(a, b) { const x = toBigInt(a), y = toBigInt(b); return x != null && y != null && x === y; }
function toBigInt(value) {
  try {
    if (value == null || typeof value === 'boolean') return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    return BigInt(value);
  } catch { return null; }
}
