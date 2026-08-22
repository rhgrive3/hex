/* Formatting helpers. All addresses are BigInt — never Number. */
import { pick } from './i18n.js';

const HEX2 = new Array(256);
for (let i = 0; i < 256; i++) HEX2[i] = i.toString(16).toUpperCase().padStart(2, '0');

export { HEX2 };

/** 64-bit safe address → "10000C3B0" (uppercase, min 8 digits). */
export function addrText(v, pad = 8) {
  let s = (v < 0n ? -v : v).toString(16).toUpperCase();
  if (s.length < pad) s = s.padStart(pad, '0');
  return (v < 0n ? '-' : '') + s;
}

/** "0x10000C3B0" */
export function addrHex(v, pad = 8) {
  return v < 0n ? '-0x' + addrText(-v, pad) : '0x' + addrText(v, pad);
}

/** "F6 57 BD A9" or "F657BDA9" */
export function bytesHex(u8, off, len, spaced = true) {
  let s = '';
  for (let i = 0; i < len; i++) {
    if (spaced && i) s += ' ';
    s += HEX2[u8[off + i]];
  }
  return s;
}

/** Printable ASCII rendering for hex mode. */
export function bytesAscii(u8, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = u8[off + i];
    s += (c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : '.';
  }
  return s;
}

/** 24.7 MB */
export function sizeText(n) {
  const v = Number(n);
  if (v < 1024) return v + pick(' バイト', ' bytes');
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1, x = v;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return (x < 10 ? x.toFixed(2) : x < 100 ? x.toFixed(1) : Math.round(x)) + ' ' + units[i];
}

/**
 * Accepts "10000C448", "0x10000C448", "0X…", with separators/whitespace.
 * Decimal requires an explicit "d" suffix or "#" prefix (rare, but avoids
 * ambiguity). Returns BigInt or null.
 */
export function parseAddress(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim().replace(/[\s_,]/g, '');
  if (!s) return null;
  let neg = false;
  if (s[0] === '+') s = s.slice(1);
  else if (s[0] === '-') { neg = true; s = s.slice(1); }
  let v;
  try {
    if (/^#\d+$/.test(s)) v = BigInt(s.slice(1));
    else if (/^\d+d$/i.test(s)) v = BigInt(s.slice(0, -1));
    else if (/^0x[0-9a-f]+$/i.test(s)) v = BigInt(s);
    else if (/^[0-9a-f]+$/i.test(s)) v = BigInt('0x' + s);
    else return null;
  } catch { return null; }
  if (v < 0n) return null;
  return neg ? -v : v;
}

/**
 * Parse a hex byte pattern: "48 65 6C", "4865??6C", "0x48,0x65".
 * Returns {bytes: Uint8Array, mask: Uint8Array} or null.
 * "?" matches any nibble.
 */
export function parseHexPattern(text) {
  const s = String(text).replace(/0x/gi, '').replace(/[\s,_-]/g, '');
  if (!s.length || s.length % 2 !== 0) return null;
  if (!/^[0-9a-f?]+$/i.test(s)) return null;
  const n = s.length / 2;
  const bytes = new Uint8Array(n), mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const hi = s[i * 2], lo = s[i * 2 + 1];
    const m = (hi === '?' ? 0x00 : 0xf0) | (lo === '?' ? 0x00 : 0x0f);
    const b = ((hi === '?' ? 0 : parseInt(hi, 16)) << 4) | (lo === '?' ? 0 : parseInt(lo, 16));
    mask[i] = m;
    bytes[i] = b & m;
  }
  return { bytes, mask };
}

/** Control-flow mnemonics get a distinct color, like Hopper/IDA. */
const FLOW = new Set([
  'b', 'bl', 'blr', 'br', 'ret', 'cbz', 'cbnz', 'tbz', 'tbnz', 'braa', 'brab',
  'blraa', 'blrab', 'retaa', 'retab', 'svc', 'brk', 'hlt', 'eret', 'bti',
]);

export function mnemonicClass(mn) {
  if (!mn) return '';
  if (mn.charCodeAt(0) === 46) return 'data';           // ".byte" from SKIPDATA
  if (FLOW.has(mn)) return 'flow';
  if (mn.charCodeAt(0) === 98 /* b */ && mn.length <= 4 && /^b\.?[a-z]{0,2}$/.test(mn)) return 'flow';
  return '';
}
