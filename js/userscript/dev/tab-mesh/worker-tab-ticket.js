const WORKER_HASH_KEY = 'hex-dev-worker';
const ID = /^[a-f0-9]{32}$/;
const SLOT = /^[1-6]$/;

export function createWorkerTabTicket({ slot, projectUrl = null, cryptoRef = globalThis.crypto } = {}) {
  const slotId = String(slot ?? '');
  if (!SLOT.test(slotId)) throw new TypeError('Worker tab slot must be 1-6.');
  const poolId = token(16, cryptoRef);
  const channelId = token(16, cryptoRef);
  const auth = token(32, cryptoRef);
  return Object.freeze({ schema: 'hex-dev-worker-tab-v1', poolId, channelId, auth, slot: Number(slotId), projectUrl: normalizeProjectUrl(projectUrl) });
}

export function encodeWorkerTabUrl(ticket, { base = 'https://chatgpt.com/' } = {}) {
  const value = normalizeTicket(ticket);
  const url = new URL(value.projectUrl || base, base);
  if (!['chatgpt.com', 'chat.openai.com'].includes(url.hostname) || url.protocol !== 'https:') throw new TypeError('Worker tab URL must be ChatGPT HTTPS.');
  const payload = new URLSearchParams({ pool: value.poolId, channel: value.channelId, auth: value.auth, slot: String(value.slot) });
  url.hash = `${WORKER_HASH_KEY}=${payload.toString()}`;
  return url.href;
}

export function readWorkerTabTicket(locationLike) {
  let url;
  try { url = new URL(String(locationLike?.href || locationLike || '')); } catch { return null; }
  const raw = String(url.hash || '').replace(/^#/, '');
  if (!raw.startsWith(`${WORKER_HASH_KEY}=`)) return null;
  const params = new URLSearchParams(raw.slice(WORKER_HASH_KEY.length + 1));
  try {
    return normalizeTicket({
      schema: 'hex-dev-worker-tab-v1', poolId: params.get('pool'), channelId: params.get('channel'), auth: params.get('auth'), slot: params.get('slot'), projectUrl: `${url.origin}${url.pathname}${url.search}`,
    });
  } catch { return null; }
}

export function scrubWorkerTabTicket(historyRef = globalThis.history, locationRef = globalThis.location) {
  const ticket = readWorkerTabTicket(locationRef);
  if (!ticket) return null;
  try {
    const url = new URL(String(locationRef.href));
    url.hash = '';
    historyRef?.replaceState?.(historyRef.state ?? null, '', `${url.pathname}${url.search}`);
  } catch {}
  return ticket;
}

export function workerChannelName(ticket) {
  const value = normalizeTicket(ticket);
  return `hex-dev-worker-${value.channelId}`;
}

export function normalizeTicket(ticket) {
  if (!ticket || typeof ticket !== 'object') throw new TypeError('Worker tab ticket is required.');
  const poolId = String(ticket.poolId || '').toLowerCase();
  const channelId = String(ticket.channelId || '').toLowerCase();
  const auth = String(ticket.auth || '').toLowerCase();
  const slot = Number(ticket.slot);
  if (!ID.test(poolId) || !ID.test(channelId) || !/^[a-f0-9]{64}$/.test(auth) || !Number.isInteger(slot) || slot < 1 || slot > 6) throw new TypeError('Worker tab ticket is invalid.');
  return Object.freeze({ schema: 'hex-dev-worker-tab-v1', poolId, channelId, auth, slot, projectUrl: normalizeProjectUrl(ticket.projectUrl) });
}

function normalizeProjectUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value), 'https://chatgpt.com/');
    if (url.protocol !== 'https:' || !['chatgpt.com','chat.openai.com'].includes(url.hostname)) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}
function token(bytes, cryptoRef) {
  if (!cryptoRef?.getRandomValues) throw new TypeError('WebCrypto is required for worker tab identity.');
  const out = cryptoRef.getRandomValues(new Uint8Array(bytes));
  return [...out].map((v) => v.toString(16).padStart(2, '0')).join('');
}
