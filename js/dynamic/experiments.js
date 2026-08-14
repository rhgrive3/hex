import { asAddress, boundedInteger, DebugAdapterError } from '../debug/adapter.js';

const I32_MIN = -2147483648n, I32_MAX = 2147483647n;
const I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n;

function uniqBig(values) {
  const seen = new Set(); const out = [];
  for (const value of values) { const v = BigInt(value); const key = v.toString(); if (!seen.has(key)) { seen.add(key); out.push(v); } }
  return out;
}

export function generateDifferentialInputs(spec = {}) {
  const bits = spec.bits === 32 ? 32 : 64;
  const signed = spec.signed !== false;
  const min = bits === 32 ? I32_MIN : I64_MIN;
  const max = bits === 32 ? I32_MAX : I64_MAX;
  const values = [0n, 1n];
  if (signed) values.push(-1n);
  values.push(2n, 7n, 16n, 127n, 255n, 1024n);
  if (spec.boundary != null) {
    const b = BigInt(spec.boundary); values.push(b - 1n, b, b + 1n);
  }
  if (spec.expected != null) {
    const b = BigInt(spec.expected); values.push(b - 1n, b, b + 1n);
  }
  values.push(bits === 32 ? 0x7fffffffn : 0x7fffffffffffffffn, max);
  if (signed) values.push(min);
  let normalized = uniqBig(values).filter((v) => signed ? v >= min && v <= max : v >= 0n && v <= max);
  const limit = boundedInteger(spec.limit, 16, 1, 64, 'differential input limit');
  normalized = normalized.slice(0, limit);
  const out = normalized.map((value,index) => ({ id:`scalar:${index}`, kind:'scalar', value }));
  if (spec.pointer !== false) out.push({ id:'pointer:null', kind:'pointer', value:0n }, { id:'pointer:nonnull', kind:'pointer', value:BigInt(spec.nonNullPointer || 0x600000001000n) });
  return out.slice(0, limit + 2);
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
  const fieldOffset = hypothesis.fieldOffset == null ? null : BigInt(hypothesis.fieldOffset);
  const fieldSize = boundedInteger(hypothesis.fieldSize, 8, 1, 8, 'fieldSize');
  const objectBase = BigInt(options.objectBase ?? hypothesis.objectBase ?? 0x600000001000n);
  const initial = BigInt(hypothesis.initial ?? options.initial ?? 100);
  const argIndex = boundedInteger(hypothesis.argumentIndex, 1, 0, 7, 'argumentIndex');
  const pointerInput = hypothesis.argumentKind === 'pointer' || hypothesis.pointer === true;
  const inputs = options.inputs || generateDifferentialInputs({ bits:fieldSize <= 4 ? 32 : 64, signed:hypothesis.signed !== false, boundary:hypothesis.boundary ?? hypothesis.clampMin ?? hypothesis.clampMax, pointer:pointerInput, limit:options.limit || 12 });
  const cases = [];
  for (const item of inputs) {
    if (item.kind !== 'scalar' && !(pointerInput && item.kind === 'pointer')) continue;
    const args = Array.from({length:Math.max(argIndex + 1, 2)}, () => 0n); args[0] = objectBase; args[argIndex] = item.value;
    const expected = item.kind === 'scalar' && fieldOffset != null ? relationExpected(hypothesis, initial, item.value) : null;
    cases.push({
      id:`${hypothesis.id || 'hypothesis'}:${item.id}`,
      input:{ arguments:args, scalar:item.value },
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

export function compareExpected(caseSpec, observation) {
  const expected = caseSpec && caseSpec.expected;
  if (!expected) return { status:'inconclusive', reason:'no-machine-checkable-expectation' };
  const stop = observation && observation.stop && observation.stop.kind;
  if (stop === 'fault' || stop === 'exception' || stop === 'timeout' || stop === 'unsupported' || stop === 'cancelled') return { status:'unsupported', reason:`execution-${stop}` };
  if (expected.field) {
    const offset = BigInt(expected.field.offset); const touched = (observation.memoryDelta || []).find((f) => f.offset != null && BigInt(f.offset) === offset);
    if (!touched) return { status:'contradicted', reason:'expected-field-was-not-modified', expected:expected.field.value };
    if (BigInt(touched.after) === BigInt(expected.field.value)) return { status:'supported', reason:'observed-field-matches', observed:touched.after, expected:expected.field.value };
    return { status:'contradicted', reason:'observed-field-mismatch', observed:touched.after, expected:expected.field.value };
  }
  if (expected.returnValue != null) return BigInt(observation.returnValue) === BigInt(expected.returnValue)
    ? { status:'supported', reason:'return-value-matches' }
    : { status:'contradicted', reason:'return-value-mismatch', observed:observation.returnValue, expected:expected.returnValue };
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
      const objectMemory = (testCase.initialState.fields || []).map((f) => ({ offset:f.offset, size:f.size, value:f.value }));
      let observation;
      try {
        await this.adapter.launch({ address:experiment.functionAddress, arguments:testCase.input.arguments, objectBase:testCase.initialState.objectBase, objectMemory, watch:testCase.watch, memoryMappings:options.memoryMappings || [], globals:options.globals || [], maxObjectSize:options.maxObjectSize, traceMemoryReads:!!options.traceMemoryReads });
        observation = await this.adapter.resume({ maxSteps:options.maxSteps || 20000 });
      } catch (error) {
        const code = String(error && error.code || '');
        const kind = code === 'unsupported' ? 'unsupported' : code === 'timeout' ? 'timeout' : code === 'cancelled' ? 'cancelled' :
          (code === 'oob' || code === 'permission' || code === 'fault' || code === 'mmio-unknown') ? 'fault' : 'exception';
        observation = { stop:{ kind, message:(error && error.message) || String(error) }, memoryDelta:[], returnValue:null };
      }
      const comparison = compareExpected(testCase, observation);
      const evidence = this.evidenceFactory ? this.evidenceFactory({ experiment, testCase, observation, comparison }) : null;
      results.push({ case:testCase, observation, comparison, evidence });
      if (options.stopOnContradiction !== false && comparison.status === 'contradicted') break;
    }
    return { experimentId:experiment.id, verdict:classifyHypothesis(results), cases:results };
  }
}
