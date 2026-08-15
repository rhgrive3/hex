/*
 * Gemini 解析クライアント。
 * API キーも Gemini の直URLもブラウザには持ち込まない。送信先は同一オリジンの
 * /api/gemini だけで、関数レポートから必要な根拠だけを上限付きで抜き出す。
 */
import { stepText } from './comprehend.js';

const MAX_ASSEMBLY_LINES = 360;
const MAX_PSEUDOCODE_LINES = 32;
const MAX_LIST_ITEMS = 40;
const MAX_STREAM_ATTEMPTS = 2;
const STREAM_RETRY_BASE_DELAY_MS = 700;
const RETRYABLE_STREAM_CODES = new Set([
  'aborted',
  'api_error',
  'deadline_exceeded',
  'rate_limit_exceeded',
  'service_unavailable',
  'stream_ended_early',
]);

export function buildGeminiPayload(report, model, question, thinkingLevel) {
  if (!report || !model) throw new Error('解析対象の関数情報がありません。');
  const assembly = assemblyContext(model);
  if (!assembly.text) throw new Error('この関数のARM64命令を取り出せませんでした。');

  return {
    question: String(question || '').trim(),
    thinkingLevel: thinkingLevel || 'high',
    currentFunction: {
      address: addressText(report.identity && report.identity.startAddr),
      name: report.identity && report.identity.name ? String(report.identity.name) : null,
      assembly: assembly.text,
      assemblyMeta: assembly.meta,
      pseudocode: pseudocodeText(report),
    },
    xrefs: xrefsFor(model),
    callers: callersFor(report),
    callees: calleesFor(report),
    strings: stringsFor(report),
    globals: globalsFor(report),
  };
}

export async function streamGemini(payload, handlers, signal) {
  for (let attempt = 1; attempt <= MAX_STREAM_ATTEMPTS; attempt++) {
    let emittedText = false;
    try {
      const completed = await streamGeminiAttempt(payload, {
        onText: (chunk) => {
          emittedText = true;
          if (handlers && handlers.onText) handlers.onText(chunk);
        },
      }, signal);
      if (handlers && handlers.onDone) handlers.onDone(completed);
      return;
    } catch (error) {
      if (!shouldRetryStream(error, emittedText, attempt, signal)) throw error;
      if (!await waitForStreamRetry(attempt, signal)) throw error;
    }
  }
}

async function streamGeminiAttempt(payload, handlers, signal) {
  const response = await fetch('/api/gemini', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new GeminiStreamError('解析サービスからストリームが返されませんでした。', 'stream_ended_early');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      const parsed = takeEvents(buffered);
      buffered = parsed.rest;
      for (const event of parsed.events) {
        if (consumeEvent(event, handlers)) completed = true;
      }
    }
    buffered += decoder.decode();
    if (buffered.trim()) {
      if (consumeEvent(buffered, handlers)) completed = true;
    }
  } finally {
    reader.releaseLock();
  }
  if (!completed) {
    throw new GeminiStreamError('解析サービスのストリームが完了前に終了しました。', 'stream_ended_early');
  }
  return true;
}

function shouldRetryStream(error, emittedText, attempt, signal) {
  if (attempt >= MAX_STREAM_ATTEMPTS || emittedText || (signal && signal.aborted)) return false;
  return error instanceof GeminiStreamError && RETRYABLE_STREAM_CODES.has(error.code);
}

async function waitForStreamRetry(attempt, signal) {
  if (signal && signal.aborted) return false;
  const delay = STREAM_RETRY_BASE_DELAY_MS * Math.max(1, attempt) + Math.floor(Math.random() * 200);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), delay);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function assemblyContext(model) {
  const all = Array.isArray(model?.instructions) ? model.instructions : [];
  const rows = all.slice(0, MAX_ASSEMBLY_LINES);
  const totalInstructions = all.length;
  const includedInstructions = rows.length;
  const truncated = totalInstructions > includedInstructions;
  const startRow = includedInstructions ? (Number.isInteger(rows[0]?.row) ? rows[0].row : 0) : null;
  const endRow = includedInstructions ? (Number.isInteger(rows[rows.length - 1]?.row) ? rows[rows.length - 1].row : includedInstructions - 1) : null;
  const rendered = rows.map((insn) => {
    const address = addressText(insn.address);
    return [address, insn.mnemonic || '', insn.operands || ''].filter(Boolean).join('  ');
  }).join('\n');
  const marker = truncated
    ? `// [Hex context incomplete: showing ${includedInstructions} of ${totalInstructions} instructions; trailing instructions omitted]`
    : '';
  return {
    text: marker ? `${marker}\n${rendered}` : rendered,
    meta: {
      totalInstructions, includedInstructions, startRow, endRow, truncated,
      omittedInstructions: Math.max(0, totalInstructions - includedInstructions),
      selection: 'head',
    },
  };
}

function assemblyText(model) { return assemblyContext(model).text; }

function pseudocodeText(report) {
  const comprehension = report.comprehension;
  if (!comprehension) return null;
  const lines = [];
  for (const step of (comprehension.steps || []).slice(0, MAX_PSEUDOCODE_LINES)) {
    try {
      lines.push(addressText(step.address) + ': ' + stepText(step));
    } catch { /* 1 行復元できなくても既存の静的解析結果だけ送る */ }
  }
  if (comprehension.ret && comprehension.ret.expr) {
    try { lines.push(addressText(comprehension.ret.address) + ': return ' + stepText({ expr: comprehension.ret.expr }).replace(/^result = /, '').replace(/;$/, '') + ';'); }
    catch { /* ignore */ }
  }
  return lines.length ? lines.join('\n') : null;
}

function xrefsFor(model) {
  return (model.addressRefs || []).slice(0, MAX_LIST_ITEMS).map((ref) => ({
    address: addressText(ref.addr != null ? ref.addr : ref.address),
    row: numberOrNull(ref.row),
    kind: textOrNull(ref.kind),
    text: textOrNull(ref.text),
  }));
}

function callersFor(report) {
  return (report.callers || []).slice(0, MAX_LIST_ITEMS).map((item) => ({
    address: addressText(item.addr),
    callSite: addressText(item.site),
    name: textOrNull(item.name),
    count: numberOrNull(item.count),
  }));
}

function calleesFor(report) {
  return (report.callees || []).slice(0, MAX_LIST_ITEMS).map((item) => ({
    address: addressText(item.addr),
    callSite: addressText(item.site),
    name: textOrNull(item.name),
    count: numberOrNull(item.count),
  }));
}

function stringsFor(report) {
  return (report.strings || []).slice(0, MAX_LIST_ITEMS).map((item) => ({
    address: addressText(item.addr),
    row: numberOrNull(item.row),
    text: textOrNull(item.text),
  }));
}

function globalsFor(report) {
  return (report.updates || []).slice(0, MAX_LIST_ITEMS).map((item) => ({
    kind: textOrNull(item.kind),
    address: addressText(item.store && item.store.address),
    base: textOrNull(item.location && item.location.base),
    offset: bigintText(item.location && item.location.disp),
    field: textOrNull(item.field && item.field.name),
    stack: item.location ? !!item.location.stack : null,
    operations: (item.steps || []).slice(0, 12).map((step) => ({
      operation: textOrNull(step.op),
      immediate: bigintText(step.imm),
      row: numberOrNull(step.row),
    })),
  }));
}

function takeEvents(text) {
  const events = [];
  let index;
  while ((index = text.indexOf('\n\n')) >= 0) {
    events.push(text.slice(0, index));
    text = text.slice(index + 2);
  }
  return { events, rest: text };
}

function consumeEvent(raw, handlers) {
  const lines = raw.split('\n');
  let eventName = '';
  const data = [];
  for (const line of lines) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  const joined = data.join('\n');
  if (!joined) return false;
  if (joined === '[DONE]') return true;

  let value;
  try { value = JSON.parse(joined); }
  catch { return false; }
  if (eventName === 'error' || value.event_type === 'error') {
    const code = value.error && typeof value.error.code === 'string' ? value.error.code : 'unknown';
    const message = value.error && value.error.message ? value.error.message : '解析サービスでエラーが発生しました。';
    throw new GeminiStreamError(message, code);
  }
  const delta = value.delta;
  if ((eventName === 'step.delta' || value.event_type === 'step.delta') && delta && delta.type === 'text' && typeof delta.text === 'string') {
    if (handlers && handlers.onText) handlers.onText(delta.text);
  }
  if (eventName === 'interaction.completed' || value.event_type === 'interaction.completed') return true;
  return false;
}

async function responseError(response) {
  let message = '解析サービスへのリクエストに失敗しました。';
  let code = 'request_failed';
  try {
    const body = await response.json();
    if (body && body.error) {
      if (typeof body.error.message === 'string') message = body.error.message;
      if (typeof body.error.code === 'string') code = body.error.code;
    }
  } catch { /* JSON でないエラー本文はブラウザへ表示しない */ }
  const error = new Error(message);
  error.code = code;
  error.status = response.status;
  return error;
}

function addressText(value) {
  if (value == null) return null;
  try {
    const n = typeof value === 'bigint' ? value : BigInt(value);
    return '0x' + n.toString(16).toUpperCase();
  } catch { return null; }
}

function bigintText(value) {
  if (value == null) return null;
  try { return BigInt(value).toString(); }
  catch { return null; }
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function textOrNull(value) {
  return typeof value === 'string' && value ? value.slice(0, 3000) : null;
}

class GeminiStreamError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GeminiStreamError';
    this.code = code;
  }
}
