from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, found {count}')
    p.write_text(text.replace(old, new, 1))


replace_once('js/semantic.js',
"""function fact(kind, inst, extra = {}) {
  const evidence = uniqueEvidence(extra.evidence || [instructionEvidence(inst)]);
  return {
    id: extra.id || ('fact:' + kind + ':' + (inst ? inst.id : 'none')),
    kind,
    row: inst && inst.row != null ? inst.row : null,
    address: inst && inst.address != null ? inst.address : null,
    function: extra.function == null ? null : extra.function,
    relation: extra.relation || null,
    confidence: extra.confidence == null ? 1 : extra.confidence,
    confidenceSource: extra.confidenceSource || 'semantic-ir',
    evidence, ...extra, evidence,
  };
}
""",
"""function fact(kind, inst, extra = {}) {
  const evidence = uniqueEvidence(extra.evidence || [instructionEvidence(inst)]);
  return {
    id: extra.id || ('fact:' + kind + ':' + (inst ? inst.id : 'none')),
    kind,
    row: inst && inst.row != null ? inst.row : null,
    address: inst && inst.address != null ? inst.address : null,
    function: extra.function == null ? null : extra.function,
    relation: extra.relation || null,
    confidence: extra.confidence == null ? 1 : extra.confidence,
    confidenceSource: extra.confidenceSource || 'semantic-ir',
    evidence, ...extra, evidence,
  };
}

function sameSemanticValue(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.id != null && b.id != null) return a.id === b.id;
  if (a.const != null && b.const != null) {
    return a.const === b.const && Number(a.bits || 64) === Number(b.bits || 64);
  }
  return false;
}

const GREATER_CONDITIONS = new Set(['gt', 'ge', 'hi', 'hs', 'cs']);
const LESSER_CONDITIONS = new Set(['lt', 'le', 'lo', 'cc', 'ls']);

/** Prove that a plain CSEL is exactly min/max of the values compared by NZCV. */
export function proveClampSelect(sel) {
  if (!sel || sel.op !== OP.SEL || sel.sub !== 'sel') return null;
  const whenTrue = sel.args?.[0]?.value || null;
  const whenFalse = sel.args?.[1]?.value || null;
  const flags = sel.args?.[2]?.value || sel.args?.[sel.args.length - 1]?.value || null;
  const cmp = flags?.def?.op === OP.CMP ? flags.def : null;
  if (!whenTrue || !whenFalse || !cmp || cmp.sub !== 'sub') return null;
  const lhs = cmp.args?.[0]?.value || null;
  const rhs = cmp.args?.[1]?.value || null;
  if (!lhs || !rhs) return null;
  const direct = sameSemanticValue(whenTrue, lhs) && sameSemanticValue(whenFalse, rhs);
  const reversed = sameSemanticValue(whenTrue, rhs) && sameSemanticValue(whenFalse, lhs);
  if (!direct && !reversed) return null;

  const cond = String(sel.cond || '').toLowerCase();
  let kind = null;
  if (GREATER_CONDITIONS.has(cond)) kind = direct ? 'max' : 'min';
  else if (LESSER_CONDITIONS.has(cond)) kind = direct ? 'min' : 'max';
  else return null;

  const constantLhs = lhs.const != null;
  const constantRhs = rhs.const != null;
  let bound = null, candidate = null;
  if (constantLhs !== constantRhs) {
    bound = constantLhs ? lhs : rhs;
    candidate = constantLhs ? rhs : lhs;
  } else {
    // Dynamic min/max is still proven; retain explicit operand identity rather
    // than inventing which side is the semantic bound.
    candidate = lhs;
  }
  return { kind, condition:cond, lhs, rhs, bound, candidate, compare:cmp };
}

const THRESHOLD_OPERATOR = Object.freeze({
  eq:'==', ne:'!=',
  lt:'<', le:'<=', gt:'>', ge:'>=',
  lo:'<', cc:'<', hi:'>', ls:'<=', hs:'>=', cs:'>=',
});
const SWAPPED_CONDITION = Object.freeze({
  eq:'eq', ne:'ne', lt:'gt', gt:'lt', le:'ge', ge:'le',
  lo:'hi', cc:'hi', hi:'lo', ls:'hs', hs:'ls', cs:'ls',
});
const SWAPPED_OPERATOR = Object.freeze({ '<':'>', '<=':'>=', '>':'<', '>=':'<=', '==':'==', '!=':'!=' });

/** Canonicalize a constant comparison to `subject operator threshold`. */
export function canonicalThresholdComparison(c) {
  if (!c) return null;
  const left = c.value || null, right = c.other || null;
  const leftConst = left?.const != null, rightConst = right?.const != null;
  if (leftConst === rightConst) return null;
  const originalCondition = String(c.cond || '').toLowerCase();
  const rawOperator = THRESHOLD_OPERATOR[originalCondition];
  if (!rawOperator) return null;
  const swapped = leftConst;
  const subject = swapped ? right : left;
  const thresholdValue = swapped ? left : right;
  const condition = swapped ? SWAPPED_CONDITION[originalCondition] : originalCondition;
  const operator = swapped ? SWAPPED_OPERATOR[rawOperator] : rawOperator;
  if (!subject || thresholdValue?.const == null || !condition || !operator) return null;
  return {
    subject,
    thresholdValue,
    threshold: thresholdValue.const,
    condition,
    operator,
    originalCondition,
    swapped,
    operands: { left, right },
  };
}
""")

replace_once('js/semantic.js',
"""    const sel = chain.find((i) => i.op === OP.SEL);
    if (sel) out.push(fact(FACT.CLAMP, sel, {
      id: base.id + ':clamp', location: base.location, value: valueShape(sel.dst),
      condition: sel.cond || null, evidence, relation: 'clamp-before-write',
    }));
""",
"""    const sel = chain.find((i) => i.op === OP.SEL && i.sub === 'sel');
    const clamp = sel ? proveClampSelect(sel) : null;
    if (clamp) out.push(fact(FACT.CLAMP, sel, {
      id: base.id + ':clamp',
      location: base.location,
      value: valueShape(sel.dst),
      condition: clamp.condition,
      clampKind: clamp.kind,
      bound: valueShape(clamp.bound),
      candidate: valueShape(clamp.candidate),
      compare: {
        left: valueShape(clamp.lhs),
        right: valueShape(clamp.rhs),
        instructionId: clamp.compare.id,
      },
      evidence,
      relation: clamp.kind === 'min' ? 'upper-clamp-before-write' : 'lower-clamp-before-write',
    }));
""")

replace_once('js/semantic.js',
"""    if (c.cond === 'cbz' || c.cond === 'cbnz') {
      out.push(fact(FACT.THRESHOLD, inst, {
        ...base, id: 'fact:threshold:' + inst.id, threshold: 0n,
        comparisonRow: inst.row, branchRow: inst.row,
      }));
      out.push(fact(FACT.ZERO_NULL, inst, {
        ...base, id: 'fact:zero:' + inst.id, threshold: 0n,
      }));
      continue;
    }

    const otherConst = c.other && c.other.const != null ? c.other.const : null;
    const valueConst = c.value && c.value.const != null ? c.value.const : null;
    if (otherConst != null || valueConst != null) {
      const threshold = otherConst != null ? otherConst : valueConst;
      out.push(fact(FACT.THRESHOLD, c.cmp || inst, {
        ...base, id: 'fact:threshold:' + inst.id, threshold,
        comparisonRow: c.cmp ? c.cmp.row : inst.row, branchRow: inst.row,
      }));
      if (threshold === 0n) out.push(fact(FACT.ZERO_NULL, c.cmp || inst, {
        ...base, id: 'fact:zero:' + inst.id, threshold: 0n,
      }));
    }
""",
"""    if (c.cond === 'cbz' || c.cond === 'cbnz') {
      const subject = valueShape(c.value);
      const canonical = {
        ...base,
        value: subject,
        subject,
        other: { kind:'constant', constant:0n, bits:c.value?.bits || 64 },
        threshold: 0n,
        operator: c.cond === 'cbz' ? '==' : '!=',
        originalCondition: c.cond,
        swapped: false,
        operands: { left: subject, right:{ kind:'constant', constant:0n, bits:c.value?.bits || 64 } },
      };
      out.push(fact(FACT.THRESHOLD, inst, {
        ...canonical, id: 'fact:threshold:' + inst.id,
        comparisonRow: inst.row, branchRow: inst.row,
      }));
      out.push(fact(FACT.ZERO_NULL, inst, {
        ...canonical, id: 'fact:zero:' + inst.id,
      }));
      continue;
    }

    const canonical = canonicalThresholdComparison(c);
    if (canonical) {
      const normalized = {
        ...base,
        condition: canonical.condition,
        originalCondition: canonical.originalCondition,
        operator: canonical.operator,
        swapped: canonical.swapped,
        threshold: canonical.threshold,
        subject: valueShape(canonical.subject),
        value: valueShape(canonical.subject),
        other: valueShape(canonical.thresholdValue),
        operands: {
          left: valueShape(canonical.operands.left),
          right: valueShape(canonical.operands.right),
        },
      };
      out.push(fact(FACT.THRESHOLD, c.cmp || inst, {
        ...normalized, id: 'fact:threshold:' + inst.id,
        comparisonRow: c.cmp ? c.cmp.row : inst.row, branchRow: inst.row,
      }));
      if (canonical.threshold === 0n) out.push(fact(FACT.ZERO_NULL, c.cmp || inst, {
        ...normalized, id: 'fact:zero:' + inst.id,
      }));
    }
""")

replace_once('js/agent/tools.js',
"""function compactFact(f) {
  return {
""",
"""export function compactFact(f) {
  return {
""")

replace_once('js/agent/tools.js',
"""    threshold: f.threshold == null ? null : f.threshold,
    condition: f.condition || null,
    source: f.source || null,
    sink: f.sink || null,
    value: f.value || null,
""",
"""    threshold: f.threshold == null ? null : f.threshold,
    condition: f.condition || null,
    originalCondition: f.originalCondition || null,
    operator: f.operator || null,
    swapped: f.swapped === true,
    subject: f.subject || null,
    other: f.other || null,
    operands: f.operands || null,
    bound: f.bound || null,
    candidate: f.candidate || null,
    clampKind: f.clampKind || null,
    compare: f.compare || null,
    source: f.source || null,
    sink: f.sink || null,
    value: f.value || null,
""")

replace_once('package.json',
"""\"semantic:test\": \"node tests/ir-dataflow.mjs""",
"""\"semantic:test\": \"node tests/issues-426-427-semantic-facts.mjs && node tests/ir-dataflow.mjs""")
