import { RuntimeAnalysisPlatform } from './index.js';

const states = new WeakMap();

function currentFileToken(app) {
  return app?.store?.get?.('fileInfo') || null;
}

function binaryHashOf(app) {
  const info = currentFileToken(app);
  return info?.hash || info?.sha256 || app?.project?.binaryHash || null;
}

/**
 * Build the narrow I/O surface consumed by the deterministic function sandbox.
 * This deliberately mirrors the proven emulator I/O path without exposing the
 * whole App object to runtime adapters.
 */
export function createAppRuntimeIO(app) {
  const regions = (app?.store?.get?.('regions') || []).filter((r) => r.exec && r.size > 0n);
  const regionAt = (addr) => regions.find((r) => addr >= r.vmAddr && addr < r.vmAddr + r.size) || null;
  return {
    read: (addr, len) => app.backend.readAt(addr, len)
      .then((r) => (r && r.found ? r.bytes : null)).catch(() => null),
    fetch: async (addr) => {
      const region = regionAt(addr);
      if (!region) return null;
      // The local concrete sandbox is ARM64 today. Do not silently reinterpret
      // variable-width architectures through the fixed-width worker row model.
      const arch = String(app?.capabilities?.architecture || app?.store?.get?.('fileInfo')?.architecture || 'arm64').toLowerCase();
      if (!/arm64|aarch64/.test(arch)) return null;
      const row = Number((addr - region.vmAddr) / 4n);
      const chunk = Math.floor(row / 1024);
      const decoded = await app.backend.fetchChunk(region.id, chunk, true);
      const index = row - chunk * 1024;
      return { mn: decoded.mn ? decoded.mn[index] : '', ops: decoded.ops ? decoded.ops[index] : '' };
    },
    isExecutable: (addr) => !!regionAt(addr),
    symbolFor: (addr) => app.symbols?.nameAt?.(addr) || null,
    labelFor: (addr) => app.symbols?.label?.(addr) || null,
  };
}

async function disposeState(state) {
  if (!state?.platform) return;
  const current = state.platform.sessions?.current;
  if (current) {
    try { await state.platform.sessions.close(current.id); } catch { /* best effort */ }
  }
}

export async function runtimePlatformForApp(app) {
  if (!app) throw new Error('runtime app is required');
  const token = currentFileToken(app);
  let state = states.get(app);
  if (state && state.fileToken !== token) {
    await disposeState(state);
    states.delete(app);
    state = null;
  }
  if (!state) {
    const platform = new RuntimeAnalysisPlatform({
      localIO: createAppRuntimeIO(app),
      sessions: { maxSessions: 2 },
    });
    state = { platform, fileToken: token };
    states.set(app, state);
  }
  if (!state.platform.sessions.current) {
    await state.platform.startSession({ adapter: 'local', binaryHash: binaryHashOf(app), connect: true });
  }
  return state.platform;
}

export function runtimeEvidenceForApp(app, functionAddress = null) {
  const state = states.get(app);
  if (!state || state.fileToken !== currentFileToken(app)) return [];
  const evidence = Array.isArray(state.platform?.evidence) ? state.platform.evidence : [];
  if (functionAddress == null) return evidence.slice();
  let address;
  try { address = BigInt(functionAddress); } catch { return []; }
  return evidence.filter((item) => {
    try { return item?.function != null && BigInt(item.function) === address; } catch { return false; }
  });
}

export async function traceAppFunction(app, functionAddress, options = {}) {
  const platform = await runtimePlatformForApp(app);
  return platform.traceFunction(functionAddress, {
    maxSteps: options.maxSteps ?? 12000,
    timeoutMs: options.timeoutMs ?? 1500,
    limit: options.limit ?? 4096,
    ...options,
  });
}

export async function verifyAppHypothesis(app, hypothesis, options = {}) {
  const platform = await runtimePlatformForApp(app);
  return platform.verifyHypothesis(hypothesis, options);
}

export async function resetAppRuntime(app) {
  const state = states.get(app);
  if (!state) return false;
  await disposeState(state);
  states.delete(app);
  return true;
}
