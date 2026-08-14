import { evalBinary, evalUnary, u } from '../truth/integer.js';

export function evaluateExpression(n, env = {}, memory = {}) {
  if (!n) return null;
  switch (n.kind) {
    case 'const': return u(n.value, n.bits);
    case 'var': return env[n.name] == null ? null : u(env[n.name], n.bits);
    case 'unary': {
      const a = evaluateExpression(n.arg, env, memory); if (a == null) return null;
      return evalUnary(n.op, a, n.bits, n.arg?.bits || n.bits);
    }
    case 'binary': {
      const a = evaluateExpression(n.left, env, memory), b = evaluateExpression(n.right, env, memory);
      if (a == null || b == null) return null;
      return evalBinary(n.op, a, b, n.bits, n.signed);
    }
    case 'compare': {
      const a = evaluateExpression(n.left, env, memory), b = evaluateExpression(n.right, env, memory);
      if (a == null || b == null) return null;
      return evalBinary(n.op, a, b, n.left?.bits || n.right?.bits || 64, n.compareSigned);
    }
    case 'select': {
      const q = evaluateExpression(n.condition, env, memory); if (q == null) return null;
      return evaluateExpression(q === 0n ? n.whenFalse : n.whenTrue, env, memory);
    }
    case 'intrinsic': {
      const args = (n.args || []).map((a) => evaluateExpression(a, env, memory));
      if (args.some((a) => a == null)) return null;
      if (n.name === 'min') return n.signed === false ? (args[0] < args[1] ? args[0] : args[1]) : (BigInt.asIntN(n.bits, args[0]) < BigInt.asIntN(n.bits, args[1]) ? args[0] : args[1]);
      if (n.name === 'max') return n.signed === false ? (args[0] > args[1] ? args[0] : args[1]) : (BigInt.asIntN(n.bits, args[0]) > BigInt.asIntN(n.bits, args[1]) ? args[0] : args[1]);
      if (n.name === 'abs') return evalUnary('abs', args[0], n.bits);
      if (n.name === 'bit_extract') {
        const lsb = Number(args[1]), width = Number(args[2]);
        return u(args[0] >> BigInt(lsb), width);
      }
      if (n.name === 'madd') return u(args[0] * args[1] + args[2], n.bits);
      if (n.name === 'msub') return u(args[0] * args[1] - args[2], n.bits);
      return null;
    }
    case 'load': return memory[n.location?.key || n.location?.name] ?? null;
    default: return null;
  }
}

export function verifyRewrite(original, rewritten, opts = {}) {
  const widths = opts.widths || [8, 16, 32, 64];
  const seeds = opts.samples || [0n, 1n, -1n, 2n, 7n, 0x7fn, 0x80n, 0xffn, 0x7fffffffn, 0x80000000n, 0xffffffffn, 0x7fffffffffffffffn, 0xffffffffffffffffn];
  const variables = [...collectVariables(original), ...collectVariables(rewritten)];
  const names = [...new Set(variables)];
  let checked = 0;
  for (const bits of widths) {
    for (let i = 0; i < seeds.length; i++) {
      const env = {};
      for (let j = 0; j < names.length; j++) env[names[j]] = u(seeds[(i + j) % seeds.length], bits);
      const a = evaluateExpression(original, env), b = evaluateExpression(rewritten, env);
      if (a == null || b == null) continue;
      checked++;
      if (u(a, original.bits || bits) !== u(b, rewritten.bits || bits)) return { equivalent: false, checked, counterexample: { bits, env, original: a, rewritten: b } };
    }
  }
  return { equivalent: true, checked };
}

export function collectVariables(n, out = new Set()) {
  if (!n) return out;
  if (n.kind === 'var') out.add(n.name);
  if (n.arg) collectVariables(n.arg, out);
  if (n.left) collectVariables(n.left, out);
  if (n.right) collectVariables(n.right, out);
  if (n.condition) collectVariables(n.condition, out);
  if (n.whenTrue) collectVariables(n.whenTrue, out);
  if (n.whenFalse) collectVariables(n.whenFalse, out);
  for (const a of n.args || []) collectVariables(a, out);
  if (n.base) collectVariables(n.base, out);
  if (n.index) collectVariables(n.index, out);
  return out;
}

export async function verifyWithFunctionSandbox(adapter, original, rewritten, cases = []) {
  if (!adapter || typeof adapter.execute !== 'function') return { available: false, reason: 'sandbox adapter unavailable' };
  const mismatches = [];
  for (const c of cases) {
    const a = await adapter.execute(original, c);
    const b = await adapter.execute(rewritten, c);
    if (JSON.stringify(a) !== JSON.stringify(b)) mismatches.push({ input: c, original: a, rewritten: b });
  }
  return { available: true, equivalent: mismatches.length === 0, checked: cases.length, mismatches: mismatches.slice(0, 8) };
}
