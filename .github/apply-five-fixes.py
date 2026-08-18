from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, got {count}')
    p.write_text(text.replace(old, new, 1))


replace_once('js/ir-core.js',
"""      .filter((inst) => inst.op === LEGACY_OP.STORE && inst.loc?.kind === LEGACY_MK.STACK
        && inst.loc.key === load.loc.key && Number(inst.row) < Number(load.row))""",
"""      .filter((inst) => inst.op === LEGACY_OP.STORE && inst.loc?.kind === LEGACY_MK.STACK
        && inst.loc.key === load.loc.key
        && Number(inst.loc?.size) > 0 && Number(load.loc?.size) > 0
        && Number(inst.loc.size) === Number(load.loc.size)
        && Number(inst.row) < Number(load.row))""")

replace_once('js/architecture/compat/ir-core-arm64-aapcs64-v1.js',
"""  if (otherLoc.kind === MK.UNKNOWN) return false;
  if (storeLoc.kind !== otherLoc.kind) return false;
  const overlap = (pa, sa, pb, sb) => !(pa + sa <= pb || pb + sb <= pa);""",
"""  if (otherLoc.kind === MK.UNKNOWN) return false;
  if (storeLoc.kind !== otherLoc.kind) {
    if (storeLoc.kind === MK.FIELD || otherLoc.kind === MK.FIELD) return true;
    return false;
  }
  const overlap = (pa, sa, pb, sb) => !(pa + sa <= pb || pb + sb <= pa);""")

replace_once('js/decompiler/ast/nodes.js',
"""  compare(op, left, right, signed = null, source = null) { return node('compare', { op, left, right, bits: 1, signed: false, compareSigned: signed, effect: maxEffect(effectOf(left), effectOf(right)) }, mergeSource(source, left?.source, right?.source)); },""",
"""  compare(op, left, right, signed = null, source = null, extra = {}) {
    const comparisonDomain = extra.comparisonDomain ?? ((left?.floating === true || right?.floating === true || left?.kind === 'float-const' || right?.kind === 'float-const') ? 'floating' : 'integer');
    return node('compare', { op, left, right, bits: 1, signed: false, compareSigned: signed, comparisonDomain, effect: maxEffect(effectOf(left), effectOf(right)), ...extra }, mergeSource(source, left?.source, right?.source));
  },""")
replace_once('js/decompiler/ast/nodes.js',
"""      case 'compare': value = `cmp:${n.op}:${n.compareSigned}:${k(n.left)}:${k(n.right)}`; break;""",
"""      case 'compare': value = `cmp:${n.op}:${n.compareSigned}:${n.comparisonDomain ?? 'unknown'}:${k(n.left)}:${k(n.right)}`; break;""")
replace_once('js/decompiler/rewrite/rules.js',
"""  match: (n) => n?.kind === 'compare' && ['eq','ne'].includes(n.op) && sameExpr(n.left, n.right) && isPure(n.left) ? {} : null,""",
"""  match: (n) => n?.kind === 'compare' && n.comparisonDomain !== 'floating' && ['eq','ne'].includes(n.op) && sameExpr(n.left, n.right) && isPure(n.left) ? {} : null,""")
replace_once('js/decompiler/flag-semantics.js',
"""function directCompare(op, left, right, signed, bits, source) {
  // The AST comparison carries signedness/width semantics. Do not inject
  // redundant textual casts here: recovered fields/locals already have their
  // declared C type, and double-casts make otherwise readable predicates noisy.
  // Architecture-specific cases that cannot be represented by a normal C
  // comparison are retained as explicit NZCV intrinsics below.
  void bits;
  return left && right ? expr.compare(op, left, right, signed, source) : null;
}""",
"""function directCompare(op, left, right, signed, bits, source, comparisonDomain = 'integer') {
  // The AST comparison carries signedness/width semantics. Do not inject
  // redundant textual casts here: recovered fields/locals already have their
  // declared C type, and double-casts make otherwise readable predicates noisy.
  // Architecture-specific cases that cannot be represented by a normal C
  // comparison are retained as explicit NZCV intrinsics below.
  void bits;
  return left && right ? expr.compare(op, left, right, signed, source, { comparisonDomain }) : null;
}""")

p = Path('js/decompiler/flag-semantics.js')
text = p.read_text()
start = text.index("  if (sub === 'fsub') {")
end = text.index("\n  if (sub === 'sub') {", start)
head, block, tail = text[:start], text[start:end], text[end:]
replacements = {
    "      case 'eq': return directCompare('eq', left, right, false, bits, source);": "      case 'eq': return directCompare('eq', left, right, false, bits, source, 'floating');",
    "      case 'ne': return directCompare('ne', left, right, false, bits, source);": "      case 'ne': return directCompare('ne', left, right, false, bits, source, 'floating');",
    "      case 'mi': case 'lo': case 'cc': return directCompare('lt', left, right, true, bits, source);": "      case 'mi': case 'lo': case 'cc': return directCompare('lt', left, right, true, bits, source, 'floating');",
    "      case 'ls': return directCompare('le', left, right, true, bits, source);": "      case 'ls': return directCompare('le', left, right, true, bits, source, 'floating');",
    "      case 'ge': return directCompare('ge', left, right, true, bits, source);": "      case 'ge': return directCompare('ge', left, right, true, bits, source, 'floating');",
    "      case 'gt': return directCompare('gt', left, right, true, bits, source);": "      case 'gt': return directCompare('gt', left, right, true, bits, source, 'floating');",
}
for old, new in replacements.items():
    if block.count(old) != 1:
        raise SystemExit(f'flag-semantics: expected one fsub match, got {block.count(old)} for {old!r}')
    block = block.replace(old, new, 1)
p.write_text(head + block + tail)

replace_once('js/semantics/ir/from-machine-effects.js',
"""    if (control.kind === 'indirect') {
      emitUnknownEffects(effect, 'unresolved-indirect-control-flow', ['control'], { control });
      return;
    }""",
"""    if (control.kind === 'indirect') {
      const targetId = control.target && typeof control.target === 'object'
        ? resolveControlCondition(effect, control.target)
        : null;
      if (!targetId) {
        emitUnknownEffects(effect, 'unresolved-indirect-control-flow', ['control'], { control });
        return;
      }
      const nodeId = nodeIdFor(effect, 'indirect-control');
      addNode({
        id: nodeId,
        kind: 'unknown-control-effect',
        blockId,
        inputs: [targetId],
        completeness: 'partial',
        unknown: {
          reason: 'indirect-target-entity-unresolved',
          categories: ['control'],
          knownParts: { control, targetValueId: targetId },
        },
        attributes: machineAttributes(effect, { machineControlEffect: control, indirectTargetValueId: targetId }),
        sourceEffectIds: [effect.sourceEffectId],
        origin: effectOrigin(effect, 'indirect-control-target-value-projection', [nodeId]),
      });
      addIssue('indirect-target-entity-unresolved', ['control'], { control, targetValueId: targetId });
      return;
    }""")

replace_once('js/targets/abi/riscv-lp64.js',
"""/* fa0-fa7 for the hardware-float variants. */
const FLOAT_ARGUMENT_REGISTERS = Object.freeze(['f10','f11','f12','f13','f14','f15','f16','f17']);""",
"""/* fa0-fa7 for the hardware-float variants. */
const FLOAT_ARGUMENT_REGISTERS = Object.freeze(['f10','f11','f12','f13','f14','f15','f16','f17']);
/* psABI floating-point register convention. */
const FLOAT_CALLER_SAVED = Object.freeze([
  'f0','f1','f2','f3','f4','f5','f6','f7',
  ...FLOAT_ARGUMENT_REGISTERS,
  'f28','f29','f30','f31',
]);
const FLOAT_CALLEE_SAVED = Object.freeze([
  'f8','f9','f18','f19','f20','f21','f22','f23','f24','f25','f26','f27',
]);
const ALL_FLOAT_REGISTERS = Object.freeze(Array.from({ length:32 }, (_, index) => `f${index}`));""")
replace_once('js/targets/abi/riscv-lp64.js',
"""function createRiscvAbi(profile) {
  const { classifyArguments, classifyReturn } = createClassifier(profile);
  const callerSaved = profile.floatAbi === 'soft'
    ? CALLER_SAVED
    : Object.freeze([...CALLER_SAVED, ...FLOAT_ARGUMENT_REGISTERS]);
  return new ABIPlugin({""",
"""function createRiscvAbi(profile) {
  const { classifyArguments, classifyReturn } = createClassifier(profile);
  const abiFlenBits = profile.floatAbi === 'single' ? 32 : profile.floatAbi === 'double' ? 64 : 0;
  const callerSavedFor = ({ valueWidthBits = null } = {}) => {
    if (profile.floatAbi === 'soft') return CALLER_SAVED;
    const width = Number(valueWidthBits);
    const calleeSavedFpWidthProven = Number.isSafeInteger(width) && width > 0 && width <= abiFlenBits;
    return calleeSavedFpWidthProven
      ? Object.freeze([...CALLER_SAVED, ...FLOAT_CALLER_SAVED])
      : Object.freeze([...CALLER_SAVED, ...ALL_FLOAT_REGISTERS]);
  };
  const calleeSavedFor = ({ valueWidthBits = null } = {}) => {
    if (profile.floatAbi === 'soft') return CALLEE_SAVED;
    const width = Number(valueWidthBits);
    const calleeSavedFpWidthProven = Number.isSafeInteger(width) && width > 0 && width <= abiFlenBits;
    return calleeSavedFpWidthProven
      ? Object.freeze([...CALLEE_SAVED, ...FLOAT_CALLEE_SAVED])
      : CALLEE_SAVED;
  };
  return new ABIPlugin({""")
replace_once('js/targets/abi/riscv-lp64.js',
"""    callerSaved:()=>callerSaved,
    calleeSaved:()=>CALLEE_SAVED,""",
"""    callerSaved:(request)=>callerSavedFor(request),
    calleeSaved:(request)=>calleeSavedFor(request),""")
replace_once('js/targets/abi/riscv-lp64.js',
"""      registerClobbers:callerSaved,""",
"""      registerClobbers:callerSavedFor(),""")

test = r'''import assert from 'node:assert/strict';
import fs from 'node:fs';
import { expr } from '../../js/decompiler/ast/nodes.js';
import { DEFAULT_RULES } from '../../js/decompiler/rewrite/rules.js';
import { buildNZCVConditionExpression } from '../../js/decompiler/flag-semantics.js';
import { RISCV_LP64F_ABI, RISCV_LP64D_ABI } from '../../js/targets/abi/riscv-lp64.js';

const reflexive = DEFAULT_RULES.find((rule) => rule.name === 'compare-self-eq-ne');
assert.ok(reflexive);
const ix = expr.variable('ix', 64, true);
assert.ok(reflexive.match(expr.compare('eq', ix, ix, true)));
const nan = expr.floatConstant(Number.NaN, 64);
const nanEq = expr.compare('eq', nan, nan, false);
assert.equal(nanEq.comparisonDomain, 'floating');
assert.equal(reflexive.match(nanEq), null);
const fv = expr.variable('fv', 64, null);
const fcmp = buildNZCVConditionExpression('fsub', 'ne', fv, fv, 64);
assert.equal(fcmp.comparisonDomain, 'floating');
assert.equal(reflexive.match(fcmp), null);

const fDefault = new Set(RISCV_LP64F_ABI.callerSaved());
for (const reg of ['f0','f7','f10','f17','f28','f31','f8']) assert.ok(fDefault.has(reg), reg);
const f32 = new Set(RISCV_LP64F_ABI.callerSaved({ valueWidthBits:32 }));
assert.ok(f32.has('f0') && f32.has('f31'));
assert.ok(!f32.has('f8'));
assert.ok(RISCV_LP64F_ABI.callerSaved({ valueWidthBits:64 }).includes('f8'));
assert.ok(!RISCV_LP64D_ABI.callerSaved({ valueWidthBits:64 }).includes('f8'));
assert.ok(RISCV_LP64D_ABI.calleeSaved({ valueWidthBits:64 }).includes('f8'));

const irCore = fs.readFileSync(new URL('../../js/ir-core.js', import.meta.url), 'utf8');
assert.match(irCore, /Number\(inst\.loc\?\.size\) > 0[\s\S]*Number\(inst\.loc\.size\) === Number\(load\.loc\.size\)/);
const legacy = fs.readFileSync(new URL('../../js/architecture/compat/ir-core-arm64-aapcs64-v1.js', import.meta.url), 'utf8');
assert.match(legacy, /storeLoc\.kind !== otherLoc\.kind[\s\S]*storeLoc\.kind === MK\.FIELD \|\| otherLoc\.kind === MK\.FIELD\) return true/);
const lowering = fs.readFileSync(new URL('../../js/semantics/ir/from-machine-effects.js', import.meta.url), 'utf8');
assert.match(lowering, /control\.kind === 'indirect'[\s\S]*resolveControlCondition\(effect, control\.target\)[\s\S]*inputs: \[targetId\][\s\S]*indirect-target-entity-unresolved/);
console.log('issues 828/832/860/867/880: PASS');
'''
Path('tests/semantic-v2/issues-828-832-860-867-880.test.mjs').write_text(test)
