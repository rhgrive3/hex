import assert from 'node:assert/strict';
import { expr, sameExpr, structuralKey } from '../../js/decompiler/ast/nodes.js';
import { DEFAULT_RULES } from '../../js/decompiler/rewrite/rules.js';

const location = Object.freeze({ kind:'field', key:'field:x0+8' });
const load = (ssaDef, row, extra = {}) => expr.load(location, 64, { ssaDef, row, ir:`load-${row}` }, extra);
const orSelf = DEFAULT_RULES.find((rule) => rule.name === 'or-self');
const andSelf = DEFAULT_RULES.find((rule) => rule.name === 'and-self');
assert.ok(orSelf && andSelf, 'idempotent read rewrite rules must exist');

// Same address, different Memory/SSA value occurrences: a call or may-alias store
// may have changed memory, so the two reads are not interchangeable.
{
  const before = load('ssa-load-before-call', 10);
  const after = load('ssa-load-after-call', 12);
  assert.equal(sameExpr(before, after), false);
  assert.notEqual(structuralKey(before), structuralKey(after));
  assert.equal(orSelf.match(expr.binary('or', before, after, 64, false)), null,
    'OR must not collapse loads separated by a potential clobber');
}

{
  const before = load('ssa-load-before-alias-store', 20);
  const after = load('ssa-load-after-alias-store', 22);
  assert.equal(sameExpr(before, after), false);
  assert.equal(andSelf.match(expr.binary('and', before, after, 64, false)), null,
    'AND must not collapse loads separated by a may-alias store');
}

// The same proven SSA value may still be folded when it is materialized twice in
// the AST: value identity, rather than address identity, is the proof.
{
  const left = load('ssa-load-same-version', 30);
  const right = load('ssa-load-same-version', 30);
  assert.equal(sameExpr(left, right), true);
  assert.ok(orSelf.match(expr.binary('or', left, right, 64, false)));
  assert.ok(andSelf.match(expr.binary('and', left, right, 64, false)));
}

// Distinct load results on opposite sides of a MemorySSA phi remain distinct.
{
  const incomingA = load('ssa-phi-incoming-a', 40);
  const incomingB = load('ssa-phi-incoming-b', 41);
  assert.equal(sameExpr(incomingA, incomingB), false);
}

// Volatile accesses are never a stable/idempotent read; distinct occurrences also
// carry distinct structural identities.
{
  const a = load('ssa-volatile-a', 50, { volatile:true });
  const b = load('ssa-volatile-b', 51, { volatile:true });
  assert.equal(sameExpr(a, b), false);
  assert.equal(orSelf.match(expr.binary('or', a, b, 64, false)), null);
}

// Source-less synthetic loads fail closed: two independently-created reads of the
// same address are not silently treated as the same value. Reusing the exact AST
// node still has stable identity.
{
  const a = expr.load(location, 64);
  const b = expr.load(location, 64);
  assert.equal(sameExpr(a, b), false);
  assert.equal(sameExpr(a, a), true);
}

console.log('issue #826 load SSA identity regressions: PASS');
