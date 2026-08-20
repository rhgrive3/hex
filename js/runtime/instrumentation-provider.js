import { DebugAdapterError } from '../debug/adapter.js';
import { RuntimeProviderSession, createRuntimeProviderDescriptor } from './provider.js';
import { RuntimeEventNormalizer } from './events.js';
import { InterventionLedger } from './evidence-bridge.js';

function requiredMethod(backend, method, capability) {
  if (typeof backend?.[method] !== 'function') throw new DebugAdapterError('unsupported', `instrumentation backend does not support ${capability || method}`);
  return backend[method].bind(backend);
}

function moduleKey(module, index) {
  return module?.bindingKey ?? module?.moduleKey ?? module?.id ?? module?.uuid ?? module?.name ?? `instrumentation-module:${index}`;
}

export class InstrumentationProvider {
  constructor(backend, options = {}) {
    if (!backend || typeof backend !== 'object') throw new DebugAdapterError('instrumentation-backend-required', 'InstrumentationProvider requires a backend');
    this.backend = backend;
    this.options = options;
    this.activeSession = null;
    this._descriptor = createRuntimeProviderDescriptor({
      id: options.id ?? `instrumentation:${backend.id ?? backend.kind ?? 'backend'}`,
      version: options.version ?? backend.version ?? '1',
      kind: 'instrumentation',
      facets: ['instrumentation'],
      capabilities: {
        probes: typeof backend.installProbe === 'function',
        intercept: typeof backend.intercept === 'function' || typeof backend.installProbe === 'function',
        replace: typeof backend.replace === 'function',
        memoryRead: typeof backend.readMemory === 'function',
        memoryWrite: typeof backend.writeMemory === 'function',
        objcRuntime: typeof backend.getObjCRuntimeInfo === 'function',
        swiftRuntime: typeof backend.getSwiftRuntimeInfo === 'function',
        ...options.capabilities,
      },
    });
  }

  descriptor() { return this._descriptor; }

  async openSession(request = {}, options = {}) {
    if (this.activeSession && !this.activeSession.closed) throw new DebugAdapterError('runtime-session-active', 'instrumentation provider already has an open session');
    let session;
    let unsubscribe = null;
    session = new RuntimeProviderSession({
      provider: this,
      request,
      close: async () => {
        if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch {} }
        unsubscribe = null;
        try { if (typeof this.backend.disconnect === 'function') await this.backend.disconnect(); }
        finally { if (this.activeSession === session) this.activeSession = null; }
      },
    });
    const normalizer = new RuntimeEventNormalizer({
      runtimeSessionId: session.runtimeSessionId,
      providerId: session.providerId,
      providerVersion: session.providerVersion,
      sessionEpoch: session.epoch,
      processKey: session.target.processKey,
      observationMode: 'observed',
    }, this.options.events || {});
    const interventions = new InterventionLedger();

    const ingest = (raw) => {
      if (typeof this.options.eventFilter === 'function' && this.options.eventFilter(raw) === false) return null;
      return normalizer.push(raw);
    };

    try {
      if (options.connect !== false && typeof this.backend.connect === 'function') await this.backend.connect(options.connectOptions || request);
      if (typeof this.backend.onEvent === 'function') {
        const maybe = this.backend.onEvent(ingest);
        if (maybe != null && typeof maybe !== 'function') throw new DebugAdapterError('event-subscription', 'instrumentation backend onEvent must return an unsubscribe function');
        unsubscribe = maybe || null;
      }
      if (typeof this.backend.getModules === 'function') {
        const modules = await this.backend.getModules();
        for (let i = 0; i < (Array.isArray(modules) ? modules.length : 0); i++) {
          const module = modules[i] || {};
          if ((module.runtimeBase ?? module.base) == null || (module.runtimeSize ?? module.size) == null) continue;
          session.modules.load({
            bindingKey: moduleKey(module, i),
            runtimeBase: module.runtimeBase ?? module.base,
            runtimeSize: module.runtimeSize ?? module.size,
            staticBase: module.staticBase ?? module.imageBase ?? null,
            pathHint: module.pathHint ?? module.path ?? module.name ?? null,
            binaryId: module.binaryId ?? (i === 0 ? request.binaryId ?? request.binaryHash : null),
            sliceId: module.sliceId ?? (i === 0 ? request.sliceId : null),
            imageId: module.imageId ?? null,
            buildIdentity: module.buildIdentity ?? module.uuid ?? null,
            identityState: module.identityState ?? (module.binaryId || (i === 0 && (request.binaryId || request.binaryHash)) ? 'exact' : 'unresolved'),
          });
        }
      }
    } catch (error) {
      session.setState('failed');
      try { await session.close(); } catch {}
      throw error;
    }

    const instrumentation = Object.freeze({
      capabilities: this._descriptor.capabilities,
      installProbe: async (spec, callOptions = {}) => {
        const install = requiredMethod(this.backend, 'installProbe', 'probe installation');
        return install(spec, callOptions);
      },
      removeProbe: async (handle, callOptions = {}) => {
        const remove = requiredMethod(this.backend, 'removeProbe', 'probe removal');
        return remove(handle, callOptions);
      },
      intercept: async (spec, callOptions = {}) => {
        if (typeof this.backend.intercept === 'function') return this.backend.intercept(spec, callOptions);
        return requiredMethod(this.backend, 'installProbe', 'interception')(spec, callOptions);
      },
      replace: async (target, replacement, callOptions = {}) => {
        if (this.options.allowReplacement !== true && callOptions.authorized !== true) throw new DebugAdapterError('permission-denied', 'instrumentation replacement requires explicit authorization');
        const replace = requiredMethod(this.backend, 'replace', 'function replacement');
        const result = await replace(target, replacement, callOptions);
        const intervention = interventions.add({
          runtimeSessionId: session.runtimeSessionId,
          providerId: session.providerId,
          kind: 'function-replacement',
          target,
          requestedChange: replacement,
          acknowledgedResult: result,
          parentInterventionIds: callOptions.parentInterventionIds ?? [],
        });
        return { result, intervention };
      },
      readMemory: async (...args) => requiredMethod(this.backend, 'readMemory', 'memory read')(...args),
      writeMemory: async (address, bytes, callOptions = {}) => {
        if (this.options.allowMemoryWrite !== true && callOptions.authorized !== true) throw new DebugAdapterError('permission-denied', 'instrumentation memory write requires explicit authorization');
        const write = requiredMethod(this.backend, 'writeMemory', 'memory write');
        const result = await write(address, bytes, callOptions);
        const intervention = interventions.add({
          runtimeSessionId: session.runtimeSessionId,
          providerId: session.providerId,
          kind: 'memory-write',
          target: { address },
          requestedChange: { bytes },
          acknowledgedResult: result,
          parentInterventionIds: callOptions.parentInterventionIds ?? [],
        });
        return { result, intervention };
      },
      getObjCRuntimeInfo: async (...args) => requiredMethod(this.backend, 'getObjCRuntimeInfo', 'Objective-C runtime metadata')(...args),
      getSwiftRuntimeInfo: async (...args) => requiredMethod(this.backend, 'getSwiftRuntimeInfo', 'Swift runtime metadata')(...args),
      events: Object.freeze({ ingest, flush: () => normalizer.flush() }),
      interventions,
      resolveAddress: (runtimeAddress, resolutionOptions = {}) => session.modules.resolve(runtimeAddress, resolutionOptions),
    });
    session.facets = Object.freeze({ instrumentation });
    session.setState('ready');
    this.activeSession = session;
    session.newProviderEpoch = (reason = 'instrumentation-provider-epoch-changed') => {
      const next = session.newEpoch(reason);
      normalizer.resetEpoch(next);
      if (typeof this.backend.setEpoch === 'function') this.backend.setEpoch(next);
      return next;
    };
    return session;
  }
}

export function createInstrumentationProvider(backend, options = {}) {
  return new InstrumentationProvider(backend, options);
}
