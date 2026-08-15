const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1/interactions';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Browser/runtime payloads are re-wrapped by the Worker (canonical system
// prompt, final-result tool and provider-specific JSON). A conservative 2x
// expansion bound plus fixed reserve prevents a browser-approved request from
// becoming an oversized provider request after that transformation.
export const PROVIDER_ENVELOPE_RESERVE_BYTES = 24 * 1024;
export const PROVIDER_WIRE_EXPANSION_FACTOR = 2;

export const TURN_PROTOCOL_INSTRUCTION = `Return exactly one tool call per turn. Call one supplied Hex read tool when more evidence is required, or call submit_hex_result when the answer is ready. Never invent a tool, address, evidence ID, symbol, or runtime fact.`;

export function resolveInferenceAdapter(env = {}) {
  const requested = String(env.AI_PROVIDER || '').trim().toLowerCase();
  if (requested === 'groq') return groqAdapter(env);
  if (requested === 'gemini') return geminiAdapter(env);
  if (env.GROQ_API_KEY && !env.GEMINI_API_KEY) return groqAdapter(env);
  return geminiAdapter(env);
}

export function clientSafeCapabilities(capabilities = {}) {
  const upstreamMax = positiveNumber(capabilities.maxRequestBytes, 160000);
  const reservedBudget = upstreamMax - PROVIDER_ENVELOPE_RESERVE_BYTES;
  const derived = reservedBudget > 0
    ? Math.floor(reservedBudget / PROVIDER_WIRE_EXPANSION_FACTOR)
    : Math.floor(upstreamMax / PROVIDER_WIRE_EXPANSION_FACTOR);
  const safeClientMax = Math.max(1, Math.min(upstreamMax, derived));
  return {
    ...capabilities,
    maxRequestBytes: safeClientMax,
    upstreamMaxRequestBytes: upstreamMax,
    requestEnvelopeReserveBytes: PROVIDER_ENVELOPE_RESERVE_BYTES,
    requestWireExpansionFactor: PROVIDER_WIRE_EXPANSION_FACTOR,
  };
}

function geminiAdapter(env) {
  const model = env.GEMINI_MODEL || 'gemini-3.7-flash';
  return {
    id: 'gemini', model, configured: !!env.GEMINI_API_KEY,
    capabilities: { provider: 'gemini', contextTokens: numberOr(env.GEMINI_CONTEXT_TOKENS, 1_000_000), maxOutputTokens: numberOr(env.GEMINI_MAX_OUTPUT_TOKENS, 8192), maxTools: numberOr(env.GEMINI_TOOL_LIMIT, 32), maxRequestBytes: numberOr(env.AI_REQUEST_LIMIT_BYTES, 160000), tpm: nullableNumber(env.GEMINI_TPM) },
    endpoint: env.GEMINI_INTERACTIONS_URL || GEMINI_URL,
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY || '' },
    build({ payload, systemInstruction, tools }) {
      return {
        model,
        input: JSON.stringify(modelInput(payload)),
        system_instruction: `${systemInstruction}\n\n${TURN_PROTOCOL_INSTRUCTION}`,
        tools: tools.map(toGeminiTool), stream: false, store: false,
        generation_config: { thinking_level: payload.mode === 'agent' ? (env.GEMINI_AGENT_THINKING || 'high') : (env.GEMINI_CHAT_THINKING || 'medium'), thinking_summaries: 'none', max_output_tokens: Math.min(numberOr(env.GEMINI_MAX_OUTPUT_TOKENS, 8192), payload.mode === 'agent' ? 8192 : 4096), tool_choice: 'any' },
      };
    },
    normalize(value) { return value; },
  };
}

function groqAdapter(env) {
  const model = env.GROQ_MODEL || 'openai/gpt-oss-120b';
  return {
    id: 'groq', model, configured: !!env.GROQ_API_KEY,
    capabilities: { provider: 'groq', contextTokens: numberOr(env.GROQ_CONTEXT_TOKENS, 131072), maxOutputTokens: numberOr(env.GROQ_MAX_OUTPUT_TOKENS, 8192), maxTools: numberOr(env.GROQ_TOOL_LIMIT, 32), maxRequestBytes: numberOr(env.AI_REQUEST_LIMIT_BYTES, 160000), tpm: nullableNumber(env.GROQ_TPM) },
    endpoint: env.GROQ_CHAT_URL || GROQ_URL,
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${env.GROQ_API_KEY || ''}` },
    build({ payload, systemInstruction, tools }) {
      return {
        model,
        messages: [
          { role: 'system', content: `${systemInstruction}\n\n${TURN_PROTOCOL_INSTRUCTION}` },
          { role: 'user', content: JSON.stringify(modelInput(payload)) },
        ],
        tools: tools.map(toOpenAITool), tool_choice: 'required', stream: false,
        max_tokens: Math.min(numberOr(env.GROQ_MAX_OUTPUT_TOKENS, 8192), payload.mode === 'agent' ? 8192 : 4096),
      };
    },
    normalize(value) {
      const call = value?.choices?.[0]?.message?.tool_calls?.[0];
      if (!call) return value;
      return { steps: [{ type: 'function_call', name: call.function?.name, arguments: call.function?.arguments || '{}' }] };
    },
  };
}

function modelInput(payload) {
  return {
    protocol: 'hex-ai-turn-v2', mode: payload.mode, style: payload.style,
    requestedScope: payload.requestedScope, effectiveScope: payload.effectiveScope,
    intent: payload.intent || null, task: payload.task || null,
    messages: payload.messages, context: payload.context,
  };
}
function toGeminiTool(tool) { return { type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema }; }
function toOpenAITool(tool) { return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }; }
function positiveNumber(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; }
function numberOr(value, fallback) { return positiveNumber(value, fallback); }
function nullableNumber(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; }
