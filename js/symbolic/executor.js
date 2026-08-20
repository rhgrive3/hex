/*
 * symbolic/executor.js — bounded light symbolic execution over Semantic IR.
 *
 * It intentionally stops on unsupported semantic operations. The executor does
 * not pretend that an unknown instruction preserved registers/memory.
 */
import { OP, MK, COND, mayAliasProvenance } from '../ir.js';
import { valueBefore } from '../dataflow-semantic.js';

export const SYM = Object.freeze({ CONST: 'const', SYMBOL: 'symbol', OP: 'op', ITE: 'ite', UNKNOWN: 'unknown' });

export function symbolic(name, meta) { return { kind: SYM.SYMBOL, name: String(name), ...(meta || {}) }; }
export function symbolicArg(index, name) { return symbolic(name || 'arg' + index, { source: 'argument', index }); }
export function symbolicField(location, name) {
  const key = location && (location.key || (location.disp != null ? String(location.disp) : null));
  return symbolic(name || ('field(' + (key || '?') + ')'), { source: 'field', location });
}

function c(value) { return { kind: SYM.CONST, value: BigInt(value) }; }
function unknown(reason, detail) { return { kind: SYM.UNKNOWN, reason, detail: detail || null }; }
function op(name, ...args) {
  if (args.every((a) => a && a.kind === SYM.CONST)) {
    const a = args[0].value, b = args[1] && args[1].value;
    try {
      if (name === 'add') return c(a + b);
      if (name === 'sub') return c(a - b);
      if (name === 'and') return c(a & b);
      if (name === 'or' || name === 'orr') return c(a | b);
      if (name === 'xor' || name === 'eor') return c(a ^ b);
      if (name === 'shl') return c(a << b);
      if (name === 'lshr') return c(a >> b);
      if (name === 'mul') return c(a * b);
    } catch { /* symbolic fallback */ }
  }
  return { kind: SYM.OP, op: name, args };
}

function binOp(name, a, b, bits = 64) {
  const width = Math.max(1, Math.min(64, Number(bits) || 64));
  if (a && b && a.kind === SYM.CONST && b.kind === SYM.CONST) {
    const av = a.value, bv = b.value;
    try {
      let value;
      if (name === 'add') value = av + bv;
      else if (name === 'sub') value = av - bv;
      else if (name === 'mul') value = av * bv;
      else if (name === 'and') value = av & bv;
      else if (name === 'or' || name === 'orr') value = av | bv;
      else if (name === 'xor' || name === 'eor') value = av ^ bv;
      else if (name === 'shl') value = av << (bv % BigInt(width));
      else if (name === 'lshr') value = BigInt.asUintN(width, av) >> (bv % BigInt(width));
      else if (name === 'ashr') value = BigInt.asIntN(width, av) >> (bv % BigInt(width));
      else return op(name, a, b);
      return c(BigInt.asUintN(width, value));
    } catch { /* symbolic fallback */ }
  }
    if (name === 'shl' || name === 'lshr' || name === 'ashr') {
  const masked = { kind:SYM.OP, op:'and', args:[b, c(BigInt(width - 1))], bits:width };
  return { kind: SYM.OP, op: name, args: [a, masked], bits:width };
}
// Symbolic integer arithmetic is still a fixed-width bitvector. Keep
// that identity even when we cannot fold the operands to constants.
return { kind: SYM.OP, op: name, args: [a, b], bits:width };

}

function cmp(name, a, b, options = {}) {
  const bits = Math.max(1, Math.min(64, Number(options.bits) || 64));
  const signed = options.signed === true ? true : options.signed === false ? false : null;
  if (a?.kind === SYM.CONST && b?.kind === SYM.CONST) {
    const au = BigInt.asUintN(bits, a.value), bu = BigInt.asUintN(bits, b.value);
    const av = signed === true ? BigInt.asIntN(bits, au) : au;
    const bv = signed === true ? BigInt.asIntN(bits, bu) : bu;
    const yes = name === '==' ? au === bu : name === '!=' ? au !== bu : name === '<' ? av < bv : name === '<=' ? av <= bv : name === '>' ? av > bv : name === '>=' ? av >= bv : null;
    if (yes != null) return { ...c(yes ? 1n : 0n), boolean:true, bits, signed };
  }
  return { kind: SYM.OP, op: name, args: [a, b], boolean: true, bits, signed };
}
function conditionIdentity(condition) {
  if (condition?.kind === SYM.OP && condition.boolean && ['==', '!=', '<', '<=', '>', '>='].includes(condition.op)) {
    const mode = condition.signed === true ? 's' : condition.signed === false ? 'u' : 'n';
    return `${mode}${condition.bits || 64}:${expressionText(condition)}`;
  }
  return expressionText(condition);
}
function negate(condition) {
  if (!condition) return unknown('missing-condition');
  if (condition.kind === SYM.CONST && condition.boolean) return { ...c(condition.value === 0n ? 1n : 0n), boolean:true };
  const inverse = { '==': '!=', '!=': '==', '<': '>=', '<=': '>', '>': '<=', '>=': '<' }[condition.op];
  if (condition.kind === SYM.OP && inverse) return { ...condition, op: inverse };
  return { kind: SYM.OP, op: 'not', args: [condition], boolean: true };
}
function constraintAllowed(existing, condition) {
  if (condition?.kind === SYM.CONST && condition.boolean) return condition.value !== 0n;
  const key = conditionIdentity(condition);
  for (const prior of existing || []) {
    if (prior?.kind === SYM.CONST && prior.boolean && prior.value === 0n) return false;
    if (conditionIdentity(negate(prior)) === key) return false;
  }
  return true;
}

export function expressionText(e) {
  if (!e) return '?';
  if (e.kind === SYM.CONST) return e.value.toString();
  if (e.kind === SYM.SYMBOL) return e.name;
  if (e.kind === SYM.UNKNOWN) return 'unknown(' + e.reason + ')';
  if (e.kind === SYM.ITE) return '(' + expressionText(e.condition) + ' ? ' + expressionText(e.then) + ' : ' + expressionText(e.else) + ')';
    if (e.kind === SYM.OP) {
  let body;
  if (e.op === 'not') body = 'not ' + expressionText(e.args[0]);
  else if (e.args.length === 1) body = e.op + '(' + expressionText(e.args[0]) + ')';
  else body = '(' + expressionText(e.args[0]) + ' ' + e.op + ' ' + expressionText(e.args[1]) + ')';
  const bits = Number(e.bits);
  return Number.isSafeInteger(bits) && bits > 0 ? `i${bits}${body}` : body;
}

  return '?';
}

function cloneState(s) {
  return {
    block: s.block,
    prevBlock: s.prevBlock,
    memory: new Map(s.memory),
    values: new Map(s.values),
    constraints: s.constraints.slice(),
    branches: s.branches.slice(),
    touchedFields: s.touchedFields.slice(),
    visits: new Map(s.visits),
    steps: s.steps,
  };
}

function fieldName(opts, loc) {
  const configured = opts && opts.symbolicFields;
  if (configured) {
    const keys = [loc && loc.key, loc && loc.disp != null ? String(loc.disp) : null].filter(Boolean);
    for (const k of keys) {
      if (configured instanceof Map && configured.has(k)) return configured.get(k);
      if (typeof configured === 'object' && Object.prototype.hasOwnProperty.call(configured, k)) return configured[k];
    }
  }
  return null;
}

function argExpr(value, opts) {
  const reg = String(value && value.reg || '');
  const m = /^x([0-7])$/.exec(reg);
  if (!m) return unknown('undefined-entry-register', { reg });
  const index = Number(m[1]);
  const configured = opts && opts.symbolicArgs;
  if (configured && typeof configured === 'object') {
    const v = configured[index] != null ? configured[index] : configured[reg];
    if (typeof v === 'bigint' || typeof v === 'number') return c(v);
    if (typeof v === 'string') return symbolicArg(index, v);
    if (v && typeof v === 'object' && v.kind) return v;
  }
  return symbolicArg(index);
}

function locationKey(loc) {
  if (!loc) return null;
  return loc.key || (loc.kind === MK.GLOBAL && loc.address != null ? 'global:' + loc.address.toString(16) : null);
}

function phiValue(inst, state) {
  if (!inst || !inst.incoming || !inst.incoming.length) return null;
  const hit = inst.incoming.find((x) => x.from === state.prevBlock);
  return hit ? hit.value : (inst.incoming.length === 1 ? inst.incoming[0].value : null);
}

function loadExpression(inst, state, opts) {
  if (!inst || !inst.loc) return unknown('missing-load-location', { instruction: inst && inst.id });
  const key = locationKey(inst.loc);
  if (key && state.memory.has(key)) {
    const remembered = state.memory.get(key);
    return remembered && remembered.value ? remembered.value : remembered;
  }
  if (inst.loc.kind === MK.UNKNOWN) return unknown('unknown-load-alias', { instruction: inst.id });
  return symbolicField(inst.loc, fieldName(opts, inst.loc));
}

function evalValue(value, state, ir, opts, memo, active) {
  if (!value) return unknown('missing-value');
  if (state.values.has(value.id)) return state.values.get(value.id);
  const stateKey = value.id + '@' + state.prevBlock + '@' + state.block;
  if (memo.has(stateKey)) return memo.get(stateKey);
  if (active.has(value.id)) return unknown('symbolic-cycle', { value: value.id });
  active.add(value.id);
  let out = null;
  if (value.const != null) out = c(value.const);
  else if (value.kind === 'arg') out = argExpr(value, opts);
  else if (!value.def) out = unknown('value-without-definition', { value: value.id });
  else {
    const d = value.def;
    if (d.op === OP.MOV && d.args[0]) out = evalValue(d.args[0].value, state, ir, opts, memo, active);
    else if (d.op === OP.PHI) {
      const chosen = phiValue(d, state);
      out = chosen ? evalValue(chosen, state, ir, opts, memo, active) : unknown('ambiguous-phi', { instruction: d.id });
    } else if (d.op === OP.BIN && d.args.length >= 2 && ['add', 'sub', 'and', 'or', 'xor', 'orr', 'eor', 'shl', 'lshr', 'ashr', 'mul'].includes(d.sub)) {
      out = binOp(d.sub,
        evalValue(d.args[0].value, state, ir, opts, memo, active),
        evalValue(d.args[1].value, state, ir, opts, memo, active),
        d.dst && d.dst.bits || value.bits || 64);
    } else if (d.op === OP.UN && d.args[0] && /^(sxt|uxt|fmov|neg)/.test(d.sub || '')) {
      const x = evalValue(d.args[0].value, state, ir, opts, memo, active);
      const toBits = d.dst && d.dst.bits || value.bits || 64;
      const m = /^(sxt|uxt)(8|16|32|64)?/.exec(d.sub || '');
      if (d.sub === 'neg') out = binOp('sub', c(0n), x, toBits);
      else if (m) {
        const fromBits = Number(m[2] || d.args[0].bits || d.args[0].value?.bits || toBits);
        if (x.kind === SYM.CONST) {
          const narrowed = m[1] === 'sxt' ? BigInt.asIntN(fromBits, x.value) : BigInt.asUintN(fromBits, x.value);
          out = c(BigInt.asUintN(toBits, narrowed));
        } else out = { kind:SYM.OP, op:m[1] === 'sxt' ? 'sext' : 'zext', args:[x], fromBits, toBits };
      } else out = x;
    } else if (d.op === OP.LOAD && d.loc) {
      out = loadExpression(d, state, opts);
    } else if (d.op === OP.SEL && d.args.length >= 2) {
      const condition = conditionFromFlags(d, state, ir, opts, memo, active);
      out = {
        kind: SYM.ITE,
        condition,
        then: evalValue(d.args[0].value, state, ir, opts, memo, active),
        else: evalValue(d.args[1].value, state, ir, opts, memo, active),
      };
    } else if (d.op === OP.ADDR && value.const != null) out = c(value.const);
    else out = unknown('unsupported-value-op', { op: d.op, sub: d.sub, instruction: d.id });
  }
  active.delete(value.id);
  memo.set(stateKey, out);
  return out;
}

function conditionFromCmp(cmpInst, condCode, state, ir, opts, memo, active) {
  if (!cmpInst || cmpInst.op !== OP.CMP || cmpInst.args.length < 2) return unknown('unsupported-compare');
  const info = COND[condCode];
  if (!info || !info.op) return unknown('unsupported-condition', { condition: condCode });
  const a = evalValue(cmpInst.args[0].value, state, ir, opts, memo, active);
  const b = evalValue(cmpInst.args[1].value, state, ir, opts, memo, active);
  const bits = Number(cmpInst.args[0]?.bits || cmpInst.args[0]?.value?.bits || cmpInst.args[1]?.bits || cmpInst.args[1]?.value?.bits || 64);
  return cmp(info.op, a, b, { bits, signed: info.signed });
}

function conditionFromFlags(inst, state, ir, opts, memo, active) {
  // Semantic-v2 compatibility carries the comparison result explicitly as a
  // value whose defining instruction is CMP. Prefer that architecture-neutral
  // proof. The legacy nzcv register identity remains a fallback for the old IR.
  const carrierArg = (inst.args || []).find((a) => a?.value?.def?.op === OP.CMP)
    ?? (inst.args || []).find((a) => a?.value?.reg === 'nzcv');
  const carrier = carrierArg?.value ?? null;
  return conditionFromCmp(carrier?.def, inst.cond, state, ir, opts, memo, active);
}

function branchCondition(inst, state, ir, opts, memo) {
  const kind = inst.extra && inst.extra.kind;
  if ((kind === 'cbz' || kind === 'cbnz') && inst.args[0]) {
    const a = evalValue(inst.args[0].value, state, ir, opts, memo, new Set());
    return cmp(kind === 'cbz' ? '==' : '!=', a, c(0n));
  }
  if (kind === 'tbz' || kind === 'tbnz') {
    const a = inst.args[0] ? evalValue(inst.args[0].value, state, ir, opts, memo, new Set()) : unknown('missing-test-value');
    const bit = BigInt(inst.extra && inst.extra.bit != null ? inst.extra.bit : 0);
    const masked = op('and', op('lshr', a, c(bit)), c(1n));
    return cmp(kind === 'tbz' ? '==' : '!=', masked, c(0n));
  }
  return conditionFromFlags(inst, state, ir, opts, memo, new Set());
}

function addressBlockMap(ir) {
  const m = new Map();
  for (const block of ir.blocks || []) {
    let first = null;
    for (const inst of block.insts || []) {
      if (inst.address != null && (first == null || inst.row < first.row)) first = inst;
    }
    if (first && first.address != null) m.set(first.address.toString(), block.index);
  }
  return m;
}

function successorsForBranch(ir, block, inst, addressMap) {
  const succ = (block && block.succ || []).slice();
  const target = inst.extra && inst.extra.target != null ? addressMap.get(inst.extra.target.toString()) : null;
  if (inst.op === OP.BR) return { target: target == null ? null : target, fallthrough: null };
  if (inst.op !== OP.CBR) return { target: null, fallthrough: null };
  let fallthrough = succ.find((b) => b !== target);
  if (target == null && succ.length === 2) return { target: null, fallthrough: null };
  if (fallthrough == null && succ.length === 1 && target !== succ[0]) fallthrough = succ[0];
  return { target, fallthrough: fallthrough == null ? null : fallthrough };
}

function stopResult(state, reason, inst) {
  return {
    status: 'unknown',
    reason,
    at: inst ? { row: inst.row, address: inst.address, op: inst.op, sub: inst.sub || null } : null,
    constraints: state.constraints.slice(),
    constraintText: state.constraints.map(expressionText),
    takenBranches: state.branches.slice(),
    touchedFields: state.touchedFields.slice(),
    returnValue: null,
  };
}

function executionBudget(value, fallback, min, max, name) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n)) throw new TypeError(`${name} must be a finite safe integer`);
  if (n < min) return min;
  return Math.min(n, max);
}

/** Explore bounded Semantic IR paths. */
export function symbolicExecute(ir, opts) {
  if (!ir || !ir.blocks || !ir.blocks.length) return { paths: [], truncated: false, engine: 'semantic-ir-symbolic' };
  const maxPaths = executionBudget(opts && opts.maxPaths, 16, 1, 64, 'maxPaths');
  const maxSteps = executionBudget(opts && opts.maxSteps, 2000, 8, 20000, 'maxSteps');
  const maxBranches = executionBudget(opts && opts.maxBranches, 32, 1, 256, 'maxBranches');
  const maxBlockVisits = executionBudget(opts && opts.maxBlockVisits, 3, 1, 32, 'maxBlockVisits');
  const timeoutMs = executionBudget(opts && opts.timeoutMs, 250, 10, 5000, 'timeoutMs');
  const cancelledFn = opts && opts.isCancelled || (() => false);
  const signal = opts && opts.signal || null;
  const cancelled = () => !!(signal && signal.aborted) || cancelledFn();
  const deadline = Date.now() + timeoutMs;
  const addressMap = addressBlockMap(ir);
  const queue = [{ block: ir.entry || 0, prevBlock: -1, memory: new Map(), values: new Map(), constraints: [], branches: [], touchedFields: [], visits: new Map(), steps: 0 }];
  const paths = [];
  let branchCount = 0;
  let truncated = false;

  while (queue.length && paths.length < maxPaths) {
    if (cancelled() || Date.now() > deadline) { truncated = true; break; }
    const state = queue.shift();
    if (state.steps > maxSteps) { paths.push(stopResult(state, 'step-budget')); continue; }
    const n = (state.visits.get(state.block) || 0) + 1;
    state.visits.set(state.block, n);
    if (n > maxBlockVisits) { paths.push(stopResult(state, 'loop-budget')); continue; }
    const block = ir.blocks[state.block];
    if (!block) { paths.push(stopResult(state, 'missing-block')); continue; }
    const memo = new Map();
    let transferred = false;

        // PHIs are parallel assignments at block entry. Evaluate every
  // incoming value against the previous iteration's state, then commit
  // the new PHI values together. Reusing the cached destination here
  // would freeze a loop-carried value after its first visit.
  const phiUpdates = [];
  for (const phi of block.phis || []) {
    if (!phi.dst) continue;
    const chosen = phiValue(phi, state);
    const value = chosen
      ? evalValue(chosen, state, ir, opts, memo, new Set())
      : unknown('ambiguous-phi', { instruction: phi.id });
    phiUpdates.push([phi.dst.id, value]);
  }
  for (const [id, value] of phiUpdates) state.values.set(id, value);


    for (const inst of block.insts || []) {
      state.steps++;
      if (state.steps > maxSteps) { paths.push(stopResult(state, 'step-budget', inst)); transferred = true; break; }

      if (inst.op === OP.LOAD) {
        if (!inst.dst || !inst.loc) {
          paths.push(stopResult(state, 'unsupported-load', inst)); transferred = true; break;
        }
        const value = loadExpression(inst, state, opts);
        if (value.kind === SYM.UNKNOWN) {
          paths.push(stopResult(state, value.reason, inst)); transferred = true; break;
        }
        state.values.set(inst.dst.id, value);
        continue;
      }
      if (inst.op === OP.STORE) {
        if (!inst.loc || inst.loc.kind === MK.UNKNOWN) {
          paths.push(stopResult(state, 'unknown-store-alias', inst)); transferred = true; break;
        }
        const key = locationKey(inst.loc);
        const value = inst.args[0] ? evalValue(inst.args[0].value, state, ir, opts, memo, new Set()) : unknown('missing-store-value');
        for (const [knownKey, remembered] of Array.from(state.memory.entries())) {
          const knownLocation = remembered && remembered.location ? remembered.location : null;
          if (!knownLocation || mayAliasProvenance(knownLocation, inst.loc)) state.memory.delete(knownKey);
        }
        if (key) state.memory.set(key, { location: inst.loc, value });
        if (inst.loc.kind === MK.FIELD || inst.loc.kind === MK.GLOBAL) {
          state.touchedFields.push({ key, location: inst.loc, row: inst.row, address: inst.address, value, valueText: expressionText(value) });
        }
        continue;
      }
      if (inst.op === OP.CALL) {
        paths.push(stopResult(state, 'unsupported-call', inst)); transferred = true; break;
      }
      if (inst.op === OP.UNKNOWN || inst.op === OP.CLOBBER) {
        paths.push(stopResult(state, 'unsupported-instruction', inst)); transferred = true; break;
      }
      if (inst.op === OP.RET) {
        const explicit = inst.args[0]?.value || null;
        let candidate = explicit;
        let inferredReturn = false;
        if (!candidate) {
          const terminal = valueBefore(ir, inst, 'x0');
          // Keep #130's ABI truth intact: RET has no implicit x0 operand. The
          // symbolic layer may expose a local terminal x0 expression only when
          // it was actually defined inside this function and evaluates to a
          // non-constant expression. This preserves field/dataflow experiments
          // while refusing the weakest `mov x0,#imm; ret` void-like ambiguity.
          if (terminal?.def && terminal.kind !== 'arg' && terminal.def.row != null && inst.row != null && terminal.def.row < inst.row) {
            const evaluated = evalValue(terminal, state, ir, opts, memo, new Set());
            if (evaluated && evaluated.kind !== SYM.UNKNOWN && evaluated.kind !== SYM.CONST) {
              candidate = terminal; inferredReturn = true;
            }
          }
        }
        const value = candidate ? evalValue(candidate, state, ir, opts, memo, new Set()) : null;
        paths.push({
          status: value && value.kind === SYM.UNKNOWN ? 'unknown' : 'complete',
          reason: value && value.kind === SYM.UNKNOWN ? value.reason : null,
          returnValue: value,
          returnText: expressionText(value),
          returnInferred: inferredReturn,
          constraints: state.constraints.slice(),
          constraintText: state.constraints.map(expressionText),
          takenBranches: state.branches.slice(),
          touchedFields: state.touchedFields.slice(),
        });
        transferred = true;
        break;
      }
      if (inst.op === OP.CBR) {
        if (++branchCount > maxBranches) { paths.push(stopResult(state, 'branch-budget', inst)); transferred = true; break; }
        const cond = branchCondition(inst, state, ir, opts, memo);
        if (cond.kind === SYM.UNKNOWN) { paths.push(stopResult(state, cond.reason, inst)); transferred = true; break; }
        const next = successorsForBranch(ir, block, inst, addressMap);
        if (next.target == null || next.fallthrough == null) { paths.push(stopResult(state, 'unresolved-branch-target', inst)); transferred = true; break; }
        const inverse = negate(cond);
        if (constraintAllowed(state.constraints, cond)) {
          const yes = cloneState(state);
          yes.prevBlock = state.block; yes.block = next.target;
          yes.constraints.push(cond);
          yes.branches.push({ row: inst.row, address: inst.address, taken: true, condition: expressionText(cond) });
          queue.push(yes);
        }
        if (constraintAllowed(state.constraints, inverse)) {
          const no = cloneState(state);
          no.prevBlock = state.block; no.block = next.fallthrough;
          no.constraints.push(inverse);
          no.branches.push({ row: inst.row, address: inst.address, taken: false, condition: expressionText(inverse) });
          queue.push(no);
        }
        transferred = true;
        break;
      }
      if (inst.op === OP.BR) {
        const next = successorsForBranch(ir, block, inst, addressMap);
        if (next.target == null) { paths.push(stopResult(state, 'unresolved-branch-target', inst)); transferred = true; break; }
        state.prevBlock = state.block; state.block = next.target; queue.push(state);
        transferred = true;
        break;
      }
    }

    if (!transferred) {
      const succ = block.succ || [];
      if (succ.length === 1) {
        state.prevBlock = state.block; state.block = succ[0]; queue.push(state);
      } else if (!succ.length) paths.push(stopResult(state, 'fell-off-function'));
      else paths.push(stopResult(state, 'ambiguous-control-flow'));
    }
  }
  if (queue.length) truncated = true;
  return { paths, truncated, engine: 'semantic-ir-symbolic' };
}