import { AIError } from '../schema.js';

export const SAFE_PROVIDER_CAPABILITIES = Object.freeze({
  contextTokens: 32768,
  maxOutputTokens: 4096,
  maxTools: 10,
  maxRequestBytes: 64 * 1024,
  tpm: null,
  provider: 'unknown',
});

export function providerCapabilities(provider) {
  const supplied = typeof provider?.getCapabilities === 'function' ? provider.getCapabilities() : provider?.capabilities;
  return { ...SAFE_PROVIDER_CAPABILITIES, ...(supplied || {}) };
}

export function measureWirePayload({ messages = [], context = {}, tools = [], meta = {} } = {}) {
  const semanticContextBytes = bytes(context);
  const toolSchemaBytes = bytes(tools);
  const historyBytes = bytes(messages);
  const wireBytes = bytes({ ...meta, messages, context, tools });
  return {
    semanticContextBytes, toolSchemaBytes, historyBytes, wireBytes,
    estimatedInputTokens: Math.ceil(wireBytes / 4),
  };
}

export function assertWireBudget(payload, capabilities = SAFE_PROVIDER_CAPABILITIES) {
  const usage = measureWirePayload(payload);
  const maxBytes = positiveLimit(capabilities.maxRequestBytes, SAFE_PROVIDER_CAPABILITIES.maxRequestBytes);
  const contextTokens = positiveLimit(capabilities.contextTokens, SAFE_PROVIDER_CAPABILITIES.contextTokens);
  const outputTokens = Math.max(0, finiteNumber(capabilities.maxOutputTokens, SAFE_PROVIDER_CAPABILITIES.maxOutputTokens));
  const maxTokens = Math.max(1, contextTokens - outputTokens);
  if (usage.wireBytes > maxBytes || usage.estimatedInputTokens > maxTokens) {
    throw new AIError('context_too_large', 'The complete provider payload exceeds the safe input budget.', { ...usage, maxBytes, maxTokens });
  }
  return usage;
}

export function semanticBudgetFor({ messages = [], tools = [], meta = {}, capabilities = SAFE_PROVIDER_CAPABILITIES, configuredBytes = 128 * 1024 } = {}) {
  const maxBytes = positiveLimit(capabilities.maxRequestBytes, SAFE_PROVIDER_CAPABILITIES.maxRequestBytes);
  const overhead = bytes({ ...meta, messages, context: {}, tools });
  const available = maxBytes - overhead - 2048;
  if (available < 4096) {
    throw new AIError('context_too_large', 'Messages and tool schemas leave no safe semantic-context budget.', { maxBytes, overhead, available });
  }
  return Math.min(positiveLimit(configuredBytes, 128 * 1024), available);
}

/*
 * Size of the payload as it is actually serialized onto the wire.
 *
 * This used to measure `JSON.stringify(jsonSafe(value))`. `jsonSafe` is a
 * presentation helper: it keeps the first 1000 array items, the first 200 keys
 * of an object, and 10 levels of depth. `WorkerAIProvider.nextTurn()` sends the
 * real `messages` / `context` / `tools` through `requestJSON()` with no such
 * truncation, so anything past those limits was measured as zero and a request
 * far over `maxRequestBytes` passed `assertWireBudget()` (#1303).
 *
 * The replacer keeps `jsonSafe`'s BigInt spelling so a payload carrying
 * addresses is still measurable, but nothing is dropped.
 */
function wireReplacer(_key, value) {
  return typeof value === 'bigint' ? `0x${value.toString(16)}` : value;
}

function bytes(value) {
  let text;
  try {
    text = JSON.stringify(value, wireReplacer);
  } catch (error) {
    // A payload that cannot be serialized cannot be sent either. Fail closed
    // rather than reporting a size for something that has none.
    throw new AIError('provider_error', 'The provider payload could not be serialized for budget measurement.', { reason: String(error?.message || error) });
  }
  return new TextEncoder().encode(text ?? 'null').byteLength;
}
function finiteNumber(value, fallback) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function positiveLimit(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; }
