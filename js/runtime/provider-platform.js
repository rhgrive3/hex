import { DebugAdapterError } from '../debug/adapter.js';
import { RuntimeProviderRegistry, wrapDebugAdapterAsRuntimeProvider } from './provider.js';
import { DebuggerProvider } from './debugger-provider.js';
import { InstrumentationProvider } from './instrumentation-provider.js';
import { TraceProvider } from './trace-provider.js';
import { EmulatorProvider } from './emulator-provider.js';

/**
 * Canonical Phase 10 composition facade.
 *
 * This lives beside RuntimeAnalysisPlatform while migration is additive. The
 * legacy runtime facade remains source-compatible; new provider-native callers
 * use this registry/session surface.
 */
export class RuntimeProviderPlatform {
  constructor(options = {}) {
    this.options = options;
    this.registry = options.registry instanceof RuntimeProviderRegistry ? options.registry : new RuntimeProviderRegistry();
    this.sessions = new Map();
    this.current = null;
  }

  register(provider) { return this.registry.register(provider); }
  unregister(id) { return this.registry.unregister(id); }
  provider(id) { return this.registry.get(id); }
  providers() { return this.registry.list(); }

  registerDebugAdapter(adapter, options = {}) {
    const provider = options.compatibilityOnly === true
      ? wrapDebugAdapterAsRuntimeProvider(adapter, options)
      : new DebuggerProvider(adapter, options);
    return this.register(provider);
  }

  registerInstrumentationBackend(backend, options = {}) {
    return this.register(new InstrumentationProvider(backend, options));
  }

  registerTrace(recording, options = {}) {
    return this.register(new TraceProvider(recording, options));
  }

  registerEmulator(engine, options = {}) {
    return this.register(new EmulatorProvider(engine, options));
  }

  async openSession(providerId, request = {}, options = {}) {
    const session = await this.registry.openSession(providerId, request, options);
    if (this.sessions.has(session.runtimeSessionId)) {
      try { await session.close(); } catch {}
      throw new DebugAdapterError('runtime-duplicate-session-id', `runtime provider session already exists: ${session.runtimeSessionId}`);
    }
    this.sessions.set(session.runtimeSessionId, session);
    this.current = session;
    const originalClose = session.close.bind(session);
    let closed = false;
    session.close = async () => {
      if (closed) return;
      closed = true;
      try { await originalClose(); }
      finally {
        if (this.sessions.get(session.runtimeSessionId) === session) this.sessions.delete(session.runtimeSessionId);
        if (this.current === session) this.current = null;
      }
    };
    return session;
  }

  getSession(runtimeSessionId) { return this.sessions.get(String(runtimeSessionId)) || null; }

  switchSession(runtimeSessionId) {
    const session = this.getSession(runtimeSessionId);
    if (!session) throw new DebugAdapterError('runtime-session-not-found', `runtime provider session not found: ${runtimeSessionId}`);
    this.current = session;
    return session;
  }

  async closeSession(runtimeSessionId) {
    const session = this.getSession(runtimeSessionId);
    if (!session) return false;
    await session.close();
    return true;
  }

  async closeAll() {
    for (const session of [...this.sessions.values()]) {
      try { await session.close(); } catch {}
    }
    this.sessions.clear();
    this.current = null;
  }
}

export { RuntimeProviderRegistry, RuntimeProviderSession, DebugAdapterRuntimeProvider, wrapDebugAdapterAsRuntimeProvider } from './provider.js';
export { DebuggerProvider, createDebuggerProvider } from './debugger-provider.js';
export { InstrumentationProvider, createInstrumentationProvider } from './instrumentation-provider.js';
export { TraceProvider, createTraceProvider } from './trace-provider.js';
export { EmulatorProvider, createEmulatorProvider } from './emulator-provider.js';
export { RuntimeModuleBindingTable, createRuntimeProviderSessionId, createRuntimeTargetBinding, createRuntimeAddressResolution } from './provider-identity.js';
export { RuntimeEventNormalizer, createRuntimeEvent, createRuntimeEventBatch, normalizeLegacyRuntimeEvent } from './events.js';
export { RuntimeEvidenceBridge, InterventionLedger, createInterventionRecord, conservativeCompleteness } from './evidence-bridge.js';
export { RuntimeProviderProtocolClient, validateProviderPacket, createProviderHello, negotiateProviderHello, RUNTIME_PROVIDER_PROTOCOL, RUNTIME_PROVIDER_PROTOCOL_VERSION } from './provider-protocol.js';
