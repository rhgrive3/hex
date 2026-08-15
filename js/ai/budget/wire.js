import { jsonSafe } from '../validation.js';
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

function bytes(value) { return new TextEncoder().encode(JSON.stringify(jsonSafe(value))).byteLength; }
function finiteNumber(value, fallback) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function positiveLimit(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; }
