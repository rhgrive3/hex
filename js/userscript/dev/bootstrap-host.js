const PROTOCOL = 'hex.dev.bootstrap-host-v1';
const MAX_HANDOFF_BYTES = 16 * 1024;

export function installDevBootstrapHost({ host, runtimeIdentity, windowRef = globalThis.window } = {}) {
  if (!host || typeof host.reload !== 'function') throw new TypeError('Dev bootstrap host requires a reloadable sandbox host.');
  const identity = normalizeRuntimeIdentity(runtimeIdentity);
  let handoff = null;
  let reloadAccepted = false;
  let closed = false;

  function currentFrameIdentity() {
    const iframe = host.iframe;
    if (!iframe?.contentWindow) return null;
    return {
      iframe,
      generation: String(iframe.dataset?.hexGeneration || ''),
      sandboxToken: String(iframe.dataset?.hexSandboxToken || '').toLowerCase(),
    };
  }

  function onMessage(event) {
    if (closed || event?.origin !== 'null') return;
    const current = currentFrameIdentity();
    if (!current || event.source !== current.iframe.contentWindow) return;
    const data = event.data;
    if (!isRecord(data) || data.protocol !== PROTOCOL) return;
    if (String(data.generation || '') !== current.generation) return;
    if (String(data.sandboxToken || '').toLowerCase() !== current.sandboxToken) return;

    if (data.type === 'hex.dev.bootstrap.handoff-request') {
      current.iframe.contentWindow.postMessage({
        protocol: PROTOCOL,
        type: 'hex.dev.bootstrap.handoff-response',
        generation: current.generation,
        sandboxToken: current.sandboxToken,
        handoff,
        runtimeIdentity: identity,
      }, '*');
      return;
    }

    if (data.type === 'hex.dev.bootstrap.reload-request') {
      if (reloadAccepted) return;
      const next = normalizeHandoff(data.handoff);
      reloadAccepted = true;
      handoff = next;
      current.iframe.contentWindow.postMessage({
        protocol: PROTOCOL,
        type: 'hex.dev.bootstrap.reload-accepted',
        generation: current.generation,
        sandboxToken: current.sandboxToken,
      }, '*');
      setTimeout(() => {
        if (!closed) void host.reload();
      }, 0);
    }
  }

  windowRef.addEventListener('message', onMessage);
  return Object.freeze({
    protocol: PROTOCOL,
    identity,
    close() {
      if (closed) return;
      closed = true;
      windowRef.removeEventListener('message', onMessage);
      handoff = null;
    },
  });
}

function normalizeRuntimeIdentity(value) {
  if (!isRecord(value)) throw new TypeError('Dev bootstrap runtime identity is required.');
  const commit = String(value.commit || '').trim().toLowerCase();
  const buildId = String(value.buildId || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new TypeError('Dev bootstrap commit identity is invalid.');
  if (!/^[0-9a-f]{24}$/.test(buildId)) throw new TypeError('Dev bootstrap build identity is invalid.');
  return Object.freeze({ commit, buildId });
}

function normalizeHandoff(value) {
  if (!isRecord(value)) throw new TypeError('Dev bootstrap handoff must be a plain object.');
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > MAX_HANDOFF_BYTES) throw new TypeError('Dev bootstrap handoff is too large.');
  const cloned = JSON.parse(text);
  if (!isRecord(cloned) || !isRecord(cloned.checkpoint)) throw new TypeError('Dev bootstrap handoff checkpoint is required.');
  return deepFreeze(cloned);
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
