/*
 * Summary scorer helper. Long call names keep the historical loose substring
 * check; short names are accepted only when the generated prose names the
 * selector/token as a delimited unit. This fixes selectors such as `new`
 * without letting `new` match `renew`, `newValue`, etc.
 */

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function summaryNamesCall(text, rawName) {
  const core = String(rawName || '')
    .replace(/^objc:/, '')
    .replace(/^_+/, '')
    .replace(/:.*$/, '');
  if (!core) return false;
  const body = String(text || '');
  if (core.length >= 4) return body.includes(core);

  const token = escapeRegExp(core);
  // Japanese quotation marks are the canonical narrator form. ASCII quotes,
  // backticks and identifier boundaries keep the helper safe for English/debug
  // output while refusing a substring embedded inside a longer identifier.
  return new RegExp(`(?:「${token}」|["'\`]${token}["'\`]|(?<![A-Za-z0-9_$])${token}(?![A-Za-z0-9_$]))`).test(body);
}
