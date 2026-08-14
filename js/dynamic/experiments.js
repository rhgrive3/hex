import { asAddress, boundedInteger, DebugAdapterError } from '../debug/adapter.js';

const I32_MIN = -2147483648n, I32_MAX = 2147483647n, U32_MAX = 0xffffffffn;
const I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n, U64_MAX = (1n << 64n) - 1n;

function uniqBig(values) {
  const seen = new Set(); const out = [];
  for (const value of values) { const v = BigInt(value); const key = v.toString(); if (!seen.has(key)) { seen.add(key); out.push(v); } }
  return out;
}

function integerInRange(value, fallback, min, max, name) {
  const n = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new DebugAdapterError('invalid-number', `${name} must be an integer in ${min}..${max}`);
  return n;
}

export function generateDifferentialInputs(spec = {}) {
  const bits = spec.bits === 32 ? 32 : 64;
  const signed = spec.signed !== false;
  const min = signed ? (bits === 32 ? I32_MIN : I64_MIN) : 0n;
  const max = signed ? (bits === 32 ? I32_MAX : I64_MAX) : (bits === 32 ? U32_MAX : U64_MAX);
  const values = [0n, 1n];
  if (signed) values.push(-1n);
  values.push(2n, 7n, 16n, 127n, 255n, 1024n);
  if (spec.boundary != null) {
    const b = BigInt(spec.boundary); values.push(b - 1n, b, b + 1n);
  }
  if (spec.expected != null) {
    const b = BigInt(spec.expected); values.push(b - 1n, b, b + 1n);
  }
  values.push(max);
  if (signed) values.push(min);
  let normalized = uniqBig(values).filter((v) => v >= min && v <= max);
  const limit = boundedInteger(spec.limit, 16, 1, 64, 'differential input limit');
  normalized = normalized.slice(0, limit);
  const out = normalized.map((value,index) => ({ id:`scalar:${index}`, kind:'scalar', value }));
  if (spec.pointer === true) {
    out.push({ id:'pointer:null', kind:'pointer', value:0n });
    out.push({ id:'pointer:nonnull', kind:'pointer', value:asAddress(spec.nonNullPointer ?? 0x600000001000n, 'nonNullPointer') });
  }
  return out.slice(0, limit + (spec.pointer === true ? 2 : 0));
}

function relationExpected(hypothesis, initial, input) {
  const op = hypothesis.operation || hypothesis.relation || 'set';
  const x = BigInt(initial ?? 0); const v = BigInt(input ?? 0);
  let result;
  if (op === 'add' || op === 'increment') result = x + v;
  else if (op === 'sub' || op === 'damage' || op === 'decrement') result = x - v;
  else if (op === 'xor') result = x ^ v;
  else if (op === 'and') result = x & v;
  else if (op === 'or') result = x | v;
  else if (op === 'set' || op === 'assign') result = v;
  else return null;
  if (hypothesis.clampMin != null && result < BigInt(hypothesis.clampMin)) result = BigInt(hypothesis.clampMin);
  if (hypothesis.clampMax != null && result > BigInt(hypothesis.clampMax)) result = BigInt(hypothesis.clampMax);
  return result;
}

export function compileExperiment(hypothesis, options = {}) {
  if (!hypothesis || typeof hypothesis !== 'object') throw new DebugAdapterError('invalid-hypothesis','hypothesis must be an object');
  const functionAddress = asAddress(hypothesis.functionAddress ?? hypothesis.function ?? options.functionAddress, 'functionAddress');
  const fieldOffset = hypothesis.fieldOffset == null ? null : asAddress(hypothesis.fieldOffset, 'fieldOffset');
  const fieldSize = integerInRange(hypothesis.fieldSize, 8, 1, 8, 'fieldSize');
  const objectBase = asAddress(options.objectBase ?? hypothesis.objectBase ?? 0x600000001000n, 'objectBase');
  const initial = BigInt(hypothesis.initial ?? options.initial ?? 100);
  const argIndex = integerInRange(hypothesis.argumentIndex, 1, 0, 7, 'argumentIndex');
  const pointerInput = hypothesis.argumentKind === 'pointer' || hypothesis.pointer === true;
  const inputs = options.inputs || generateDifferentialInputs({ bits:fieldSize <= 4 ? 32 : 64, signed:hypothesis.signed !== false, boundary:hypothesis.boundary ?? hypothesis.clampMin ?? hypothesis.clampMax, pointer:pointerInput, limit:options.limit ?? 12 });
  const cases = [];
  for (const item of inputs) {
    if (item.kind !== 'scalar' && !(pointerInput && item.kind === 'pointer')) continue;
    const args = Array.from({length:Math.max(argIndex + 1, 2)}, () => 0n); args[0] = objectBase; args[argIndex] = BigInt(item.value);
    const expected = item.kind === 'scalar' && fieldOffset != null ? relationExpected(hypothesis, initial, item.value) : null;
    cases.push({
      id:`${hypothesis.id || 'hypothesis'}:${item.id}`,
      input:{ arguments:args, scalar:BigInt(item.value) },
      initialState:{ objectBase, fields:fieldOffset == null ? [] : [{ offset:fieldOffset, size:fieldSize, value:initial }] },
      watch:fieldOffset == null ? [] : [{ name:hypothesis.fieldName || null, offset:fieldOffset, size:fieldSize }],
      expected: expected == null ? null : { field:{ offset:fieldOffset, value:expected } },
    });
  }
  return {
    id:String(hypothesis.id || `experiment:${functionAddress.toString(16)}`),
    hypothesis:{ ...hypothesis, functionAddress, fieldOffset },
    functionAddress, binaryHash:options.binaryHash || hypothesis.binaryHash || null,
    cases, generated:true, compiler:'runtime-experiment-v1'
  };
}

function observedFieldValue(observation, offset) {
  const after = (observation && observation.memoryAfter) || [];
  const final = after.find((f) => f && f.offset != null && BigInt(f.offset) === offset);
  if (final && final.value != null) return { observed:true, value:final.value, source:'final-state' };
  const touched = ((observation && observation.memoryDelta) || []).find((f) => f && f.offset != null && BigInt(f.offset) === offset);
  if (touched && touched.after != null) return { observed:true, value:touched.after, source:'delta' };
  return { observed:false, value:null, source:null };
}

export function compareExpected(caseSpec, observation) {
  const expected = caseSpec && caseSpec.expected;
  if (!expected) return { status:'inconclusive', reason:'no-machine-checkable-expectation' };
  const stop = observation && observation.stop && observation.stop.kind;
  if (stop === 'fault' || stop === 'exception' || stop === 'timeout' || stop === 'unsupported' || stop === 'cancelled') return { status:'unsupported', reason:`execution-${stop}` };
  if (expected.field) {
    const offset = BigInt(expected.field.offset);
    const actual = observedFieldValue(observation, offset);
    if (!actual.observed) return { status:'inconclusive', reason:'expected-field-final-state-not-observed', expected:expected.field.value };
    if (BigInt(actual.value) === BigInt(expected.field.value)) return { status:'supported', reason:'observed-field-matches', observed:actual.value, expected:expected.field.value, source:actual.source };
    return { status:'contradicted', reason:'observed-field-mismatch', observed:actual.value, expected:expected.field.value, source:actual.source };
  }
  if (expected.returnValue != null) {
    if (observation == null || observation.returnValue == null) return { status:'inconclusive', reason:'return-value-not-observed', expected:expected.returnValue };
    return BigInt(observation.returnValue) === BigInt(expected.returnValue)
      ? { status:'supported', reason:'return-value-matches', observed:observation.returnValue, expected:expected.returnValue }
      : { status:'contradicted', reason:'return-value-mismatch', observed:observation.returnValue, expected:expected.returnValue };
  }
  return { status:'inconclusive', reason:'unsupported-expectation-shape' };
}

export function classifyHypothesis(caseResults) {
  const results = Array.isArray(caseResults) ? caseResults : [];
  if (!results.length) return { status:'inconclusive', confidence:0, reason:'no-runtime-cases' };
  const usable = results.filter((r) => r.comparison && r.comparison.status !== 'unsupported');
  const contradicted = usable.filter((r) => r.comparison.status === 'contradicted').length;
  const supported = usable.filter((r) => r.comparison.status === 'supported').length;
  if (contradicted) return { status:'contradicted', confidence:Math.min(0.99, 0.7 + contradicted * 0.08), supported, contradicted, total:results.length };
  if (!usable.length) return { status:'unsupported', confidence:0, supported:0, contradicted:0, total:results.length };
  if (supported >= 3 && supported === results.length) return { status:'confirmed', confidence:Math.min(0.98, 0.75 + supported * 0.04), supported, contradicted:0, total:results.length };
  if (supported) return { status:'supported', confidence:Math.min(0.85, 0.55 + supported * 0.05), supported, contradicted:0, total:results.length };
  return { status:'inconclusive', confidence:0.25, supported:0, contradicted:0, total:results.length };
}

export class HypothesisVerifier {
  constructor(adapter, evidenceFactory = null) { this.adapter = adapter; this.evidenceFactory = evidenceFactory; }
  async verify(experiment, options = {}) {
    const results = []; const maxCases = boundedInteger(options.maxCases, experiment.cases.length, 1, 64, 'maxCases');
    for (const testCase of experiment.cases.slice(0,maxCases)) {
      let observation;
      if (options.signal && options.signal.aborted) {
        observation = { stop:{ kind:'cancelled', message:String(options.signal.reason || 'cancelled') }, memoryDelta:[], memoryAfter:[], returnValue:null };
      } else {
        const objectMemory = (testCase.initialState.fields || []).map((f) => ({ offset:f.offset, size:f.size, value:f.value }));
        try {
          await this.adapter.launch({ address:experiment.functionAddress, arguments:testCase.input.arguments, objectBase:testCase.initialState.objectBase, objectMemory, watch:testCase.watch, memoryMappings:options.memoryMappings || [], globals:options.globals || [], maxObjectSize:options.maxObjectSize, traceMemoryReads:!!options.traceMemoryReads }, { signal:options.signal });
          observation = await this.adapter.resume({ maxSteps:options.maxSteps ?? 20000, timeoutMs:options.timeoutMs, signal:options.signal });
        } catch (error) {
          const code = String(error && error.code || '');
          const kind = code === 'unsupported' ? 'unsupported' : code === 'timeout' ? 'timeout' : code === 'cancelled' || code === 'stale-request' ? 'cancelled' :
            (code === 'oob' || code === 'permission' || code === 'fault' || code === 'mmio-unknown') ? 'fault' : 'exception';
          observation = { stop:{ kind, message:(error && error.message) || String(error) }, memoryDelta:[], memoryAfter:[], returnValue:null };
        }
      }
      const comparison = compareExpected(testCase, observation);
      const evidence = this.evidenceFactory ? this.evidenceFactory({ experiment, testCase, observation, comparison }) : null;
      results.push({ case:testCase, observation, comparison, evidence });
      if (comparison.status === 'unsupported' && observation.stop && observation.stop.kind === 'cancelled') break;
      if (options.stopOnContradiction !== false && comparison.status === 'contradicted') break;
    }
    return { experimentId:experiment.id, verdict:classifyHypothesis(results), cases:results };
  }
}
