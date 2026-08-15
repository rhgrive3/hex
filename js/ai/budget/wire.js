import { jsonSafe } from '../validation.js';
import { AIError } from '../schema.js';

export const SAFE_PROVIDER_CAPABILITIES = Object.freeze({
  contextTokens: 32768,
  maxOutputTokens: 4096,
  maxTools: 10,
  maxRequestBytes: 150 * 1024,
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
  const maxBytes = Math.max(16 * 1024, Number(capabilities.maxRequestBytes || SAFE_PROVIDER_CAPABILITIES.maxRequestBytes));
  const maxTokens = Math.max(1024, Number(capabilities.contextTokens || SAFE_PROVIDER_CAPABILITIES.contextTokens) - Number(capabilities.maxOutputTokens || 0));
  if (usage.wireBytes > maxBytes || usage.estimatedInputTokens > maxTokens) {
    throw new AIError('context_too_large', 'The complete provider payload exceeds the safe input budget.', { ...usage, maxBytes, maxTokens });
  }
  return usage;
}

export function semanticBudgetFor({ messages = [], tools = [], meta = {}, capabilities = SAFE_PROVIDER_CAPABILITIES, configuredBytes = 128 * 1024 } = {}) {
  const maxBytes = Math.max(16 * 1024, Number(capabilities.maxRequestBytes || SAFE_PROVIDER_CAPABILITIES.maxRequestBytes));
  const overhead = bytes({ ...meta, messages, context: {}, tools });
  return Math.max(4096, Math.min(Number(configuredBytes), maxBytes - overhead - 2048));
}

function bytes(value) { return new TextEncoder().encode(JSON.stringify(jsonSafe(value))).byteLength; }
