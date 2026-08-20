import { deepFreeze } from '../core/identity/index.js';
import { DebugAdapterError } from '../debug/adapter.js';
import {
  RuntimeModuleBindingTable,
  createRuntimeProviderSessionId,
  createRuntimeTargetBinding,
} from './provider-identity.js';

export const RUNTIME_FACETS = Object.freeze(['debugger', 'instrumentation', 'trace', 'emulator']);
export const RUNTIME_SESSION_STATES = Object.freeze(['opening', 'ready', 'running', 'paused', 'degraded', 'disconnected', 'closing', 'closed', 'failed']);

function required(value, code, message) {
  const text = String(value ?? '').trim();
  if (!text) throw new DebugAdapterError(code, message || code);
  return text;
}

function normalizeFacetNames(value) {
  if (value == null) return Object.freeze([]);
  const source = Array.isArray(value) ? value : Object.keys(value).filter((key) => value[key]);
  const out = [...new Set(source.map(String))];
  for (const facet of out) if (!RUNTIME_FACETS.includes(facet)) throw new DebugAdapterError('runtime-invalid-facet', `unsupported runtime facet: ${facet}`);
  return Object.freeze(out.sort());
}

export function createRuntimeProviderDescriptor(input = {}) {
  return deepFreeze({
    id: required(input.id, 'runtime-provider-id-required', 'runtime provider id is required'),
    version: String(input.version ?? '1'),
    kind: String(input.kind ?? 'generic'),
    facets: normalizeFacetNames(input.facets),
    capabilities: input.capabilities && typeof input.capabilities === 'object' ? { ...input.capabilities } : {},
  });
}

export class RuntimeProviderSession {
  constructor({ provider, request = {}, target, facets = {}, close }) {
    this.provider = provider;
    this.providerId = provider.descriptor().id;
    this.providerVersion = provider.descriptor().version;
    this.runtimeSessionId = createRuntimeProviderSessionId({
      binaryId: request.binaryId ?? request.binaryHash,
      providerId: this.providerId,
      targetIdentity: request.targetIdentity ?? request.target ?? { processKey: request.processKey ?? 'default' },
      sessionNonce: request.sessionNonce ?? request.startedAt ?? `${Date.now()}:${Math.random()}`,
    });
    this.target = createRuntimeTargetBinding({
      runtimeSessionId: this.runtimeSessionId,
      providerId: this.providerId,
      providerVersion: this.providerVersion,
      processKey: request.processKey,
      platform: request.platform,
      architecture: request.architecture,
      primaryBinaryId: request.binaryId ?? request.binaryHash,
      primarySliceId: request.sliceId,
      startedAt: request.startedAt,
      bindingEvidenceIds: request.bindingEvidenceIds,
      ...target,
    });
    this.facets = Object.freeze({ ...facets });
    this.modules = new RuntimeModuleBindingTable(this.runtimeSessionId);
    this.state = 'opening';
    this.epoch = 1;
    this.closed = false;
    this.controllers = new Set();
    this._close = typeof close === 'function' ? close : null;
  }

  setState(next) {
    const state = String(next);
    if (!RUNTIME_SESSION_STATES.includes(state)) throw new DebugAdapterError('runtime-invalid-session-state', `invalid runtime session state: ${state}`);
    if (this.closed && state !== 'closed') throw new DebugAdapterError('runtime-session-closed', 'cannot transition a closed runtime provider session');
    this.state = state;
    return state;
  }

  controller() {
    if (this.closed) throw new DebugAdapterError('runtime-session-closed', 'runtime provider session is closed');
    const controller = new AbortController();
    this.controllers.add(controller);
    controller.signal.addEventListener('abort', () => this.controllers.delete(controller), { once: true });
    return controller;
  }

  releaseController(controller) { this.controllers.delete(controller); }

  cancelAll(reason = 'cancelled') {
    for (const controller of [...this.controllers]) controller.abort(reason);
    this.controllers.clear();
  }

  newEpoch(reason = 'runtime-session-epoch-changed') {
    if (this.closed) throw new DebugAdapterError('runtime-session-closed', 'runtime provider session is closed');
    this.epoch++;
    this.cancelAll(reason);
    return this.epoch;
  }

  async close() {
    if (this.closed) return;
    this.setState('closing');
    this.cancelAll('runtime-session-closing');
    try { if (this._close) await this._close(this); }
    finally {
      this.closed = true;
      this.state = 'closed';
    }
  }
}

export class RuntimeProviderRegistry {
  constructor() { this.providers = new Map(); }

  register(provider) {
    if (!provider || typeof provider.descriptor !== 'function' || typeof provider.openSession !== 'function') {
      throw new DebugAdapterError('runtime-invalid-provider', 'runtime provider requires descriptor() and openSession()');
    }
    const descriptor = createRuntimeProviderDescriptor(provider.descriptor());
    if (this.providers.has(descriptor.id)) throw new DebugAdapterError('runtime-duplicate-provider', `runtime provider already registered: ${descriptor.id}`);
    this.providers.set(descriptor.id, provider);
    return provider;
  }

  unregister(id) { return this.providers.delete(String(id)); }
  get(id) { return this.providers.get(String(id)) || null; }
  list() { return Object.freeze([...this.providers.values()].map((provider) => createRuntimeProviderDescriptor(provider.descriptor()))); }

  async openSession(providerId, request = {}, options = {}) {
    const provider = this.get(providerId);
    if (!provider) throw new DebugAdapterError('runtime-provider-not-found', `runtime provider not found: ${providerId}`);
    const session = await provider.openSession(request, options);
    if (!(session instanceof RuntimeProviderSession)) throw new DebugAdapterError('runtime-invalid-session', 'runtime provider returned an invalid session');
    return session;
  }
}

function adapterFacetNames(adapter) {
  const facets = new Set(['debugger']);
  if (adapter?.kind === 'frida' || adapter?.capabilities?.objcRuntime || adapter?.capabilities?.swiftRuntime) facets.add('instrumentation');
  if (adapter?.kind === 'replay' || adapter?.capabilities?.replay || adapter?.capabilities?.traceFunction) facets.add('trace');
  if (adapter?.kind === 'emulator' || adapter?.kind === 'local' || adapter?.kind === 'sandbox') facets.add('emulator');
  return [...facets];
}

function debuggerFacet(adapter, session) {
  return Object.freeze({
    adapter,
    capabilities: adapter.capabilities,
    attach: (...args) => adapter.attach(...args),
    launch: (...args) => adapter.launch(...args),
    pause: (...args) => adapter.pause(...args),
    resume: (...args) => adapter.resume(...args),
    stepInto: (...args) => adapter.stepInto(...args),
    stepOver: (...args) => adapter.stepOver(...args),
    stepOut: (...args) => adapter.stepOut(...args),
    setBreakpoint: (...args) => adapter.setBreakpoint(...args),
    removeBreakpoint: (...args) => adapter.removeBreakpoint(...args),
    listBreakpoints: (...args) => adapter.listBreakpoints(...args),
    readRegisters: (...args) => adapter.readRegisters(...args),
    writeRegister: async (...args) => {
      const result = await adapter.writeRegister(...args);
      return { result, intervention: { kind: 'register-write', runtimeSessionId: session.runtimeSessionId } };
    },
    readMemory: (...args) => adapter.readMemory(...args),
    writeMemory: async (...args) => {
      const result = await adapter.writeMemory(...args);
      return { result, intervention: { kind: 'memory-write', runtimeSessionId: session.runtimeSessionId } };
    },
    getThreads: (...args) => adapter.getThreads(...args),
    getModules: (...args) => adapter.getModules(...args),
    getBacktrace: (...args) => adapter.getBacktrace(...args),
    evaluate: (...args) => adapter.evaluate(...args),
  });
}

function traceFacet(adapter) {
  return Object.freeze({
    capabilities: adapter.capabilities,
    trace: (...args) => adapter.trace(...args),
    replay: (...args) => adapter.replay(...args),
  });
}

function instrumentationFacet(adapter, session) {
  return Object.freeze({
    compatibility: true,
    capabilities: adapter.capabilities,
    trace: (...args) => adapter.trace(...args),
    getObjCRuntimeInfo: (...args) => adapter.getObjCRuntimeInfo(...args),
    getSwiftRuntimeInfo: (...args) => adapter.getSwiftRuntimeInfo(...args),
    interventionContext: () => ({ runtimeSessionId: session.runtimeSessionId }),
  });
}

function emulatorFacet(adapter) {
  return Object.freeze({ compatibility: true, capabilities: adapter.capabilities, launch: (...args) => adapter.launch(...args), resume: (...args) => adapter.resume(...args) });
}

export class DebugAdapterRuntimeProvider {
  constructor(adapter, options = {}) {
    if (!adapter) throw new DebugAdapterError('adapter', 'DebugAdapterRuntimeProvider requires an adapter');
    this.adapter = adapter;
    this.options = options;
    this.activeSession = null;
    this._descriptor = createRuntimeProviderDescriptor({
      id: options.id ?? `adapter:${adapter.id}`,
      version: options.version ?? '1',
      kind: options.kind ?? adapter.kind,
      facets: adapterFacetNames(adapter),
      capabilities: adapter.capabilities,
    });
  }

  descriptor() { return this._descriptor; }

  async openSession(request = {}, options = {}) {
    if (this.activeSession && !this.activeSession.closed) throw new DebugAdapterError('adapter-in-use', 'debug adapter compatibility provider supports one live session');
    let session;
    session = new RuntimeProviderSession({
      provider: this,
      request,
      close: async () => {
        try { if (this.adapter.connected) await this.adapter.disconnect(); }
        finally { if (this.activeSession === session) this.activeSession = null; }
      },
    });
    const facets = {};
    if (this._descriptor.facets.includes('debugger')) facets.debugger = debuggerFacet(this.adapter, session);
    if (this._descriptor.facets.includes('instrumentation')) facets.instrumentation = instrumentationFacet(this.adapter, session);
    if (this._descriptor.facets.includes('trace')) facets.trace = traceFacet(this.adapter);
    if (this._descriptor.facets.includes('emulator')) facets.emulator = emulatorFacet(this.adapter);
    session.facets = Object.freeze(facets);
    this.activeSession = session;

    try {
      if (options.connect !== false && !this.adapter.connected) await this.adapter.connect(options.connectOptions || {});
      if (this.adapter.capabilities?.modules && typeof this.adapter.getModules === 'function') {
        const modules = await this.adapter.getModules();
        for (let i = 0; i < (Array.isArray(modules) ? modules.length : 0); i++) {
          const module = modules[i] || {};
          if (module.base == null || module.size == null) continue;
          session.modules.load({
            bindingKey: module.id ?? module.uuid ?? module.name ?? `module:${i}`,
            runtimeBase: module.base,
            runtimeSize: module.size,
            staticBase: module.staticBase ?? module.imageBase ?? null,
            pathHint: module.path ?? module.name ?? null,
            binaryId: module.binaryId ?? (i === 0 ? request.binaryId ?? request.binaryHash : null),
            sliceId: module.sliceId ?? (i === 0 ? request.sliceId : null),
            imageId: module.imageId ?? null,
            buildIdentity: module.buildIdentity ?? module.uuid ?? null,
            identityState: module.binaryId || (i === 0 && (request.binaryId || request.binaryHash)) ? 'exact' : 'unresolved',
          });
        }
      }
      session.setState('ready');
      return session;
    } catch (error) {
      session.setState('failed');
      try { await session.close(); } catch {}
      throw error;
    }
  }
}

export function wrapDebugAdapterAsRuntimeProvider(adapter, options = {}) {
  return new DebugAdapterRuntimeProvider(adapter, options);
}
