import { normalizeTicket, workerChannelName } from './worker-tab-ticket.js';

const PROTOCOL = 'hex-dev-worker-channel-v1';

export function createAuthBroadcastPort(ticket, { BroadcastChannelRef = globalThis.BroadcastChannel } = {}) {
  const value = normalizeTicket(ticket);
  if (typeof BroadcastChannelRef !== 'function') throw portError('broadcast-unavailable', 'BroadcastChannel is unavailable for multi-tab Worker transport.');
  const channel = new BroadcastChannelRef(workerChannelName(value));
  const listeners = new Set();
  let onmessage = null;
  let closed = false;
  const receive = (event) => {
    const envelope = event?.data;
    if (!envelope || envelope.protocol !== PROTOCOL || envelope.auth !== value.auth || envelope.poolId !== value.poolId || Number(envelope.slot) !== value.slot) return;
    const wrapped = { data: envelope.data };
    try { onmessage?.(wrapped); } catch {}
    for (const listener of [...listeners]) try { listener(wrapped); } catch {}
  };
  channel.addEventListener?.('message', receive);
  if (!channel.addEventListener) channel.onmessage = receive;
  return {
    get onmessage() { return onmessage; },
    set onmessage(valueRef) { onmessage = typeof valueRef === 'function' ? valueRef : null; },
    postMessage(data) {
      if (closed) throw portError('transport-closed', 'Worker tab channel is closed.');
      channel.postMessage({ protocol: PROTOCOL, auth: value.auth, poolId: value.poolId, slot: value.slot, data });
    },
    addEventListener(type, listener) { if (type === 'message' && typeof listener === 'function') listeners.add(listener); },
    removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
    start() {},
    close() {
      if (closed) return;
      closed = true;
      listeners.clear(); onmessage = null;
      try { channel.removeEventListener?.('message', receive); } catch {}
      try { channel.close?.(); } catch {}
    },
  };
}

function portError(code, message) { const error = new Error(message); error.code = code; return error; }
