import { effectOf } from '../ast/nodes.js';

const PREC = { select: 2, oror: 3, andand: 4, or: 5, xor: 6, and: 7, eq: 8, ne: 8, lt: 9, le: 9, gt: 9, ge: 9, shl: 10, lshr: 10, ashr: 10, add: 11, sub: 11, mul: 12, sdiv: 12, udiv: 12, smod: 12, umod: 12, unary: 13, primary: 15 };
const OP_TEXT = { add: '+', sub: '-', mul: '*', and: '&', or: '|', xor: '^', shl: '<<', lshr: '>>', ashr: '>>', sdiv: '/', udiv: '/', smod: '%', umod: '%', eq: '==', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=' };

export function integerText(v, bits = 64, signed = null) {
  const n = BigInt(v);
  const width = Math.max(1, Number(bits || 64));
  const sv = BigInt.asIntN(width, n);
  if (signed === true && sv >= -9n && sv <= 99n) return sv.toString();
  if (width <= 64) {
    if (n >= 0n && n <= 99n) return n.toString();
    if (sv < 0n && signed === true) return sv.toString();
    return `0x${BigInt.asUintN(width, n).toString(16).toUpperCase()}`;
  }

  // C has no portable integer-literal suffix for __int128.  Build the value
  // from 64-bit chunks so the printed program preserves every source bit.
  const uv = BigInt.asUintN(width, n);
  const lo = uv & ((1n << 64n) - 1n);
  const hi = uv >> 64n;
  const wide = `(((unsigned __int128)0x${hi.toString(16).toUpperCase()}ULL << 64) | 0x${lo.toString(16).toUpperCase()}ULL)`;
  return signed === true ? `((__int128)${wide})` : wide;
}

function floatText(value, bits = 64) {
  const n = Number(value);
  if (Number.isNaN(n)) return 'NAN';
  if (n === Infinity) return 'INFINITY';
  if (n === -Infinity) return '-INFINITY';
  let text = Object.is(n, -0) ? '-0.0' : String(n);
  if (!/[.eE]/.test(text)) text += '.0';
  return Number(bits || 64) <= 32 ? text + 'f' : text;
}

function wrap(text, p, parent) { return p < parent ? `(${text})` : text; }

export function printExpression(n, parentPrec = 0, opts = {}) {
  if (!n) return 'unknown';
  switch (n.kind) {
    case 'const': return integerText(n.value, n.bits, n.signed);
    case 'float-const': return floatText(n.value, n.bits);
    case 'var': return n.name || 'value';
    case 'field': return `${printExpression(n.base, PREC.primary, opts)}->${n.name || `field_${BigInt(n.offset || 0).toString(16).toUpperCase()}`}`;
    case 'index': return `${printExpression(n.base, PREC.primary, opts)}[${printExpression(n.index, 0, opts)}]`;
    case 'load': return n.location?.text || n.location?.name || `memory_${String(n.location?.key || 'unknown').replace(/[^A-Za-z0-9_]/g, '_')}`;
    case 'call': return `${n.callee || 'unknown_call'}(${(n.args || []).map((a) => printExpression(a, 0, opts)).join(', ')})`;
    case 'intrinsic': {
      if (n.name === 'madd' && n.args?.length === 3) {
        const text = `${printExpression(n.args[0], PREC.mul, opts)} * ${printExpression(n.args[1], PREC.mul, opts)} + ${printExpression(n.args[2], PREC.add + 1, opts)}`;
        return wrap(text, PREC.add, parentPrec);
      }
      if (n.name === 'msub' && n.args?.length === 3) {
        const text = `${printExpression(n.args[0], PREC.mul, opts)} * ${printExpression(n.args[1], PREC.mul, opts)} - ${printExpression(n.args[2], PREC.add + 1, opts)}`;
        return wrap(text, PREC.sub, parentPrec);
      }
      return `${n.name}(${(n.args || []).map((a) => printExpression(a, 0, opts)).join(', ')})`;
    }
    case 'unary': {
      const op = { neg: '-', not: '~', lnot: '!' }[n.op];
      if (op) return wrap(`${op}${printExpression(n.arg, PREC.unary, opts)}`, PREC.unary, parentPrec);
      if (n.op === 'trunc' || n.op === 'zext' || n.op === 'sext') {
        const sign = n.op === 'sext' ? 'int' : 'uint';
        return `(${sign}${n.bits}_t)${printExpression(n.arg, PREC.unary, opts)}`;
      }
      return `${n.op}(${printExpression(n.arg, 0, opts)})`;
    }
    case 'compare': {
      const p = PREC[n.op] || 8, text = `${printExpression(n.left, p, opts)} ${OP_TEXT[n.op] || n.op} ${printExpression(n.right, p + 1, opts)}`;
      return wrap(text, p, parentPrec);
    }
    case 'binary': {
      const p = PREC[n.op] || 11;
      const text = `${printExpression(n.left, p, opts)} ${OP_TEXT[n.op] || n.op} ${printExpression(n.right, p + (['sub','sdiv','udiv','smod','umod','shl','lshr','ashr'].includes(n.op) ? 1 : 0), opts)}`;
      return wrap(text, p, parentPrec);
    }
    case 'select': {
      const text = `${printExpression(n.condition, PREC.select + 1, opts)} ? ${printExpression(n.whenTrue, PREC.select, opts)} : ${printExpression(n.whenFalse, PREC.select, opts)}`;
      return wrap(text, PREC.select, parentPrec);
    }
    default: return n.name || 'unknown';
  }
}

function splitLong(text, width, indent) {
  if (text.length + indent.length <= width) return [text];
  const candidates = [' && ', ' || ', ', ', ' + ', ' - '];
  for (const sep of candidates) {
    const parts = text.split(sep);
    if (parts.length <= 1) continue;
    const out = [parts[0] + sep.trimEnd()];
    for (let i = 1; i < parts.length; i++) out.push('    ' + parts[i] + (i < parts.length - 1 ? sep.trimEnd() : ''));
    return out;
  }
  return [text];
}

export function printProgram(cAst, opts = {}) {
  const width = Math.max(48, Number(opts.columnWidth || 88));
  const lines = [];
  const mapping = [];
  for (const n of cAst?.body || []) {
    const indent = '    '.repeat(Math.max(0, n.indent || 0));
    const text = n.text ?? '';
    const chunks = splitLong(text, width, indent);
    const start = lines.length;
    for (const chunk of chunks) lines.push(indent + chunk);
    mapping.push({ outputStartLine: start + 1, outputEndLine: lines.length, source: n.source, kind: n.kind });
  }
  return { text: lines.join('\n'), lines, mapping };
}

export function expressionReadability(n) {
  const text = printExpression(n);
  return { characters: text.length, effect: effectOf(n), casts: (text.match(/\([ui]nt\d+_t\)/g) || []).length, temporaries: (text.match(/\b(?:v|tmp)\d+\b/g) || []).length };
}
