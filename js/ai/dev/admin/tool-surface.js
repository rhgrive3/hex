import {
  DEV_BATCH_MAX_CALLS,
  DEV_BATCH_POLICY,
  DEV_OPERATION_CLASS,
  DEV_TOOL_SURFACE,
  devToolBatchArgumentValidator,
  devToolContract,
  devToolContractsForSurface,
} from '../protocol/dev-tool-contracts.js';
import { describeDevToolError, isTerminalDevToolError } from '../supervisor/tool-error-recovery.js';

const ADMIN_CONTRACTS = devToolContractsForSurface(DEV_TOOL_SURFACE.ADMIN);
const DEV_BATCH_MAX_INPUT_CHARS = 32 * 1024;
const DEV_BATCH_MAX_RESULT_CHARS = 64 * 1024;
const DEV_BATCH_MAX_TOTAL_RESULT_CHARS = 192 * 1024;

/* Names and client-method mapping both come from the canonical registry, so a
   tool cannot be exposed here without the prompt contract, operation class and
   owner that the registry requires it to declare. */
export const DEV_ADMIN_TOOL = Object.freeze(Object.fromEntries(
  ADMIN_CONTRACTS.map((contract) => [adminConstantName(contract.publicName), contract.publicName]),
));
export const DEV_ADMIN_TOOLS = Object.freeze(ADMIN_CONTRACTS.map((contract) => contract.publicName));

export function createDevAdminToolSurface(client) {
  if (!client || typeof client !== 'object' || client.enabled === false) return null;
  const handlers = new Map();
  for (const contract of ADMIN_CONTRACTS) {
    if (contract.publicName === DEV_ADMIN_TOOL.BATCH_OBSERVE) continue;
    register(handlers, client, contract.publicName, contract.clientMethod);
  }
  const batchContract = ADMIN_CONTRACTS.find((contract) => contract.publicName === DEV_ADMIN_TOOL.BATCH_OBSERVE);
  if (batchContract && [...handlers.keys()].some((tool) => isBatchEligible(devToolContract(tool)))) {
    handlers.set(batchContract.publicName, (args) => executeObservationBatch(args, handlers));
  }
  if (!handlers.size) return null;
  return Object.freeze({
    toolNames: Object.freeze([...handlers.keys()]),
    has(name) { return handlers.has(String(name || '')); },
    execute(name, args = {}) {
      const handler = handlers.get(String(name || ''));
      if (!handler) throw new TypeError(`Unavailable Dev Admin tool: ${name}`);
      return handler(args);
    },
  });
}

/* dev.runtime.identity -> RUNTIME_IDENTITY, worker.pool.create_chat -> POOL_CREATE_CHAT.
   The historic constant names drop the leading namespace segment. */
function adminConstantName(publicName) {
  const parts = String(publicName).split('.');
  const named = parts.length > 2 ? parts.slice(1) : parts;
  return named.join('_').toUpperCase();
}
function register(handlers, client, tool, method) { if (typeof client?.[method] === 'function') handlers.set(tool, (args) => client[method](args || {})); }

function executeObservationBatch(args, handlers) {
  const calls = validateObservationBatch(args, handlers);
  return executeValidatedObservationBatch(calls, handlers);
}

async function executeValidatedObservationBatch(calls, handlers) {
  const results = [];
  let resultChars = 0;
  for (const call of calls) {
    try {
      const result = await handlers.get(call.tool)(call.arguments);
      const size = jsonSize(result);
      if (size > DEV_BATCH_MAX_RESULT_CHARS || resultChars + size > DEV_BATCH_MAX_TOTAL_RESULT_CHARS) {
        const error = new Error('Observation result exceeds the bounded batch result budget.');
        error.code = 'dev-batch-result-too-large';
        throw error;
      }
      resultChars += size;
      results.push(Object.freeze({ index: call.index, tool: call.tool, ok: true, result }));
    } catch (error) {
      /* Preserve the existing terminal boundary. Ordinary target failures are
         evidence for this batch entry; integrity, security, cancellation and
         invariant failures must still reach the normal Supervisor boundary. */
      if (isTerminalDevToolError(error)) throw error;
      results.push(Object.freeze({
        index: call.index,
        tool: call.tool,
        ok: false,
        error: normalizeBatchError(error),
      }));
    }
  }
  return Object.freeze({ results: Object.freeze(results) });
}

function validateObservationBatch(args, handlers) {
  if (!isPlainRecord(args)) throw new TypeError('dev.batch.observe arguments must be a plain object.');
  assertExactKeys(args, ['calls'], 'dev.batch.observe arguments');
  if (!Array.isArray(args.calls)) throw new TypeError('dev.batch.observe calls must be an array.');
  if (args.calls.length === 0) throw new TypeError('dev.batch.observe calls must not be empty.');
  if (args.calls.length > DEV_BATCH_MAX_CALLS) {
    throw new TypeError(`dev.batch.observe accepts at most ${DEV_BATCH_MAX_CALLS} calls.`);
  }
  assertBatchPayloadSize(args.calls, DEV_BATCH_MAX_INPUT_CHARS, 'dev.batch.observe input');

  const validated = [];
  for (let index = 0; index < args.calls.length; index++) {
    const call = args.calls[index];
    if (!isPlainRecord(call)) throw new TypeError(`dev.batch.observe call ${index} must be an object.`);
    assertAllowedKeys(call, ['tool', 'arguments'], `dev.batch.observe call ${index}`);
    if (!hasOwn(call, 'tool') || typeof call.tool !== 'string' || !call.tool.trim() || call.tool !== call.tool.trim()) {
      throw new TypeError(`dev.batch.observe call ${index} has an invalid tool.`);
    }
    if (call.tool === DEV_ADMIN_TOOL.BATCH_OBSERVE) {
      throw new TypeError('Nested dev.batch.observe calls are not allowed.');
    }

    const contract = devToolContract(call.tool);
    if (!contract) throw new TypeError(`Unknown Dev observation tool: ${call.tool}`);
    if (!isBatchEligible(contract)) {
      throw new TypeError(`Dev tool is not eligible for observation batching: ${call.tool}`);
    }

    const handler = handlers.get(call.tool);
    if (typeof handler !== 'function') throw new TypeError(`Unavailable Dev observation tool: ${call.tool}`);

    const callArguments = hasOwn(call, 'arguments') ? call.arguments : {};
    if (!isPlainRecord(callArguments)) {
      throw new TypeError(`dev.batch.observe call ${index}.arguments must be a plain object.`);
    }
    assertJsonSafe(callArguments);
    const validator = devToolBatchArgumentValidator(call.tool);
    if (typeof validator !== 'function') throw new TypeError(`Missing batch argument contract for ${call.tool}`);
    try {
      validator(callArguments);
    } catch (error) {
      throw new TypeError(`Invalid arguments for ${call.tool}: ${String(error?.message || error)}`);
    }
    validated.push(Object.freeze({ index, tool: call.tool, arguments: callArguments }));
  }
  return validated;
}

function isBatchEligible(contract) {
  return contract?.operationClass === DEV_OPERATION_CLASS.OBSERVATION
    && contract.batchPolicy === DEV_BATCH_POLICY.OBSERVATION;
}

function normalizeBatchError(error) {
  let described;
  try {
    described = describeDevToolError(error);
  } catch {
    described = { code: 'dev-tool-error', name: null, message: 'Dev tool failed.' };
  }
  const code = boundedErrorCode(described?.code);
  const name = described?.name == null ? null : boundedText(described.name, 128, 'Error');
  const message = boundedText(described?.message, 512, 'Dev tool failed.');
  return Object.freeze({ code, name, message });
}

function boundedErrorCode(value) {
  const code = String(value || '').trim();
  return /^[a-z0-9.-]{1,64}$/i.test(code) ? code : 'dev-tool-error';
}

function boundedText(value, max, fallback) {
  const text = String(value || fallback);
  return text.length > max ? text.slice(0, max) : text;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new TypeError(`${label} has an invalid shape.`);
  }
}

function assertAllowedKeys(value, allowed, label) {
  const expected = new Set(allowed);
  if (Object.keys(value).some((key) => !expected.has(key))) throw new TypeError(`${label} has an invalid shape.`);
}

function assertJsonSafe(value, depth = 0, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || depth >= 32 || ancestors.has(value)) {
    throw new TypeError('dev.batch.observe arguments must be JSON-safe.');
  }
  if (!Array.isArray(value) && !isPlainRecord(value)) {
    throw new TypeError('dev.batch.observe arguments must be JSON-safe.');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        if (!hasOwn(value, index)) throw new TypeError('dev.batch.observe arguments must be JSON-safe.');
        assertJsonSafe(value[index], depth + 1, ancestors);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) {
        throw new TypeError('dev.batch.observe arguments contain an unsafe key.');
      }
      assertJsonSafe(child, depth + 1, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function assertBatchPayloadSize(value, maxChars, label) {
  const size = jsonSize(value);
  if (size > maxChars) throw new TypeError(`${label} exceeds its bounded input budget.`);
}

function jsonSize(value) {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string') throw new TypeError('Batch value must be JSON-serializable.');
  return encoded.length;
}

function hasOwn(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
