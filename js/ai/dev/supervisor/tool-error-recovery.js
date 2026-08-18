/* Recoverable Dev tool failures must stay inside the Supervisor decision loop.
   A tool that throws is evidence for the next decision, not a reason to end the
   run. Only cancellation and explicitly fatal invariant/security/runtime
   corruption failures are terminal. */

export const DEV_TOOL_ERROR_HISTORY_KIND = 'tool-error';
export const DEV_TOOL_ERROR_RECOVERY_BUDGET = 6;

export const DEV_TERMINAL_TOOL_ERROR_CODES = Object.freeze([
  'dev-extension-untrusted',
  'dev-extension-integrity-mismatch',
  'dev-extension-version-mismatch',
  'dev-extension-tool-call-active',
  'dev-bootstrap-identity-mismatch',
  'dev-runtime-corruption',
  'dev-security-violation',
  'dev-invariant-violation',
]);

const TERMINAL_CODES = new Set(DEV_TERMINAL_TOOL_ERROR_CODES);
const TERMINAL_CODE_PREFIXES = Object.freeze(['dev-security-', 'dev-invariant-', 'dev-runtime-corruption']);
const ABORT_CODES = new Set(['cancelled', 'ABORT_ERR', 'dev-run-cancelled']);
const SENSITIVE_KEY = /(token|secret|password|passphrase|credential|cookie|authorization|api[-_]?key|session[-_]?key|nonce)/i;
const REDACTED = '[redacted]';
const MAX_TEXT_CHARS = 160;
const MAX_MESSAGE_CHARS = 512;
const MAX_KEYS = 24;
const MAX_ITEMS = 12;
const MAX_DEPTH = 3;

export function isDevToolAbort(error) {
  if (!error) return false;
  if (String(error.name || '') === 'AbortError') return true;
  return ABORT_CODES.has(String(error.code || ''));
}

/* Terminal failures are enumerated on purpose: anything not named here is
   handed back to the Supervisor instead of failing the whole run. */
export function isTerminalDevToolError(error) {
  if (isDevToolAbort(error)) return true;
  if (error?.fatal === true) return true;
  const code = String(error?.code || '');
  if (!code) return false;
  if (TERMINAL_CODES.has(code)) return true;
  return TERMINAL_CODE_PREFIXES.some((prefix) => code.startsWith(prefix));
}

export function describeDevToolError(error) {
  const name = String(error?.name || '').trim();
  const code = String(error?.code || '').trim() || name || 'dev-tool-error';
  const message = String(error?.message || error || 'Dev tool failed.').slice(0, MAX_MESSAGE_CHARS);
  return Object.freeze({ code, name: name || null, message });
}

export function sanitizeDevToolArguments(value) {
  return Object.freeze(sanitizeValue(value, 0));
}

export function createDevToolErrorHistoryEntry({ tool, purpose = null, error, attempt, remaining }) {
  const described = describeDevToolError(error);
  return {
    kind: DEV_TOOL_ERROR_HISTORY_KIND,
    tool: String(tool || ''),
    purpose: purpose == null ? null : String(purpose),
    code: described.code,
    message: described.message,
    recoverable: true,
    attempt,
    remainingRecoveries: remaining,
    guidance: 'このツール呼び出しだけが失敗した。runは継続している。同じツールの再試行・別ツールへの切り替え・状態の再観測のいずれかを選び、次のdecisionを1つ返すこと。',
  };
}

function sanitizeValue(value, depth) {
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string') return truncate(value);
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return `[array:${value.length}]`;
    const items = value.slice(0, MAX_ITEMS).map((item) => sanitizeValue(item, depth + 1));
    if (value.length > MAX_ITEMS) items.push(`[+${value.length - MAX_ITEMS} more]`);
    return items;
  }
  if (typeof value !== 'object') return `[${typeof value}]`;
  if (depth >= MAX_DEPTH) return '[object]';
  const out = {};
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (count >= MAX_KEYS) { out['[truncated]'] = true; break; }
    count += 1;
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitizeValue(item, depth + 1);
  }
  return out;
}

function truncate(text) {
  const value = String(text);
  return value.length > MAX_TEXT_CHARS ? `${value.slice(0, MAX_TEXT_CHARS)}…[+${value.length - MAX_TEXT_CHARS}]` : value;
}
