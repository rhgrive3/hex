import { DebugAdapterError } from '../debug/adapter.js';
import { DebugAdapterRuntimeProvider } from './provider.js';
import { RuntimeEventNormalizer } from './events.js';
import { InterventionLedger } from './evidence-bridge.js';

function moduleFields(event) {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  const module = payload.module && typeof payload.module === 'object' ? payload.module : payload;
  return module;
}

export class DebuggerProvider extends DebugAdapterRuntimeProvider {
  constructor(adapter, options = {}) {
    super(adapter, { ...options, kind: options.kind ?? adapter?.kind ?? 'debugger' });
    this.eventOptions = options.events || {};
  }

  async openSession(request = {}, options = {}) {
    const session = await super.openSession(request, options);
    const normalizer = new RuntimeEventNormalizer({
      runtimeSessionId: session.runtimeSessionId,
      providerId: session.providerId,
      providerVersion: session.providerVersion,
      sessionEpoch: session.epoch,
      processKey: session.target.processKey,
    }, this.eventOptions);
    const interventions = new InterventionLedger();
    let unsubscribe = null;

    const ingest = (raw) => {
      const event = normalizer.push(raw);
      if (!event) return null;
      const module = moduleFields(event);
      if (event.kind === 'module-load' && (module.runtimeBase ?? module.base) != null && (module.runtimeSize ?? module.size) != null) {
        const bindingKey = module.bindingKey ?? module.moduleKey ?? module.id ?? module.uuid ?? module.name;
        if (bindingKey) {
          const existing = session.modules.get(bindingKey);
          if (!existing) {
            session.modules.load({
              bindingKey,
              runtimeBase: module.runtimeBase ?? module.base,
              runtimeSize: module.runtimeSize ?? module.size,
              staticBase: module.staticBase ?? module.imageBase ?? null,
              pathHint: module.pathHint ?? module.path ?? module.name ?? null,
              binaryId: module.binaryId ?? null,
              sliceId: module.sliceId ?? null,
              imageId: module.imageId ?? null,
              buildIdentity: module.buildIdentity ?? module.uuid ?? null,
              identityState: module.identityState ?? (module.binaryId ? 'exact' : 'unresolved'),
              loadedSequence: event.sequence,
              identityEvidenceIds: module.identityEvidenceIds ?? [],
            });
          }
        }
      } else if (event.kind === 'module-unload') {
        const bindingKey = module.bindingKey ?? module.moduleKey ?? module.id ?? module.uuid ?? module.name;
        if (bindingKey) session.modules.unload(bindingKey, event.sequence);
      } else if (event.kind === 'paused' || event.kind === 'breakpoint-hit' || event.kind === 'watchpoint-hit') {
        session.setState('paused');
      } else if (event.kind === 'resumed') {
        session.setState('running');
      } else if (event.kind === 'provider-error') {
        session.setState('degraded');
      }
      return event;
    };

    if (typeof this.adapter.onEvent === 'function') {
      const maybe = this.adapter.onEvent(ingest);
      if (maybe != null && typeof maybe !== 'function') throw new DebugAdapterError('event-subscription', 'debugger adapter onEvent must return an unsubscribe function');
      unsubscribe = maybe || null;
    }

    const originalDebugger = session.facets.debugger;
    const debuggerFacet = Object.freeze({
      ...originalDebugger,
      writeRegister: async (name, value, callOptions = {}) => {
        const raw = await this.adapter.writeRegister(name, value, callOptions);
        const intervention = interventions.add({
          runtimeSessionId: session.runtimeSessionId,
          providerId: session.providerId,
          kind: 'register-write',
          target: { register: String(name) },
          requestedChange: { value },
          acknowledgedResult: raw,
          parentInterventionIds: callOptions.parentInterventionIds ?? [],
        });
        return { result: raw, intervention };
      },
      writeMemory: async (address, bytes, callOptions = {}) => {
        const raw = await this.adapter.writeMemory(address, bytes, callOptions);
        const intervention = interventions.add({
          runtimeSessionId: session.runtimeSessionId,
          providerId: session.providerId,
          kind: 'memory-write',
          target: { address },
          requestedChange: { bytes },
          acknowledgedResult: raw,
          parentInterventionIds: callOptions.parentInterventionIds ?? [],
        });
        return { result: raw, intervention };
      },
      events: Object.freeze({
        ingest,
        flush: () => normalizer.flush(),
      }),
      interventions,
      resolveAddress: (runtimeAddress, resolutionOptions = {}) => session.modules.resolve(runtimeAddress, resolutionOptions),
      refreshModules: async () => {
        if (!this.adapter.capabilities?.modules || typeof this.adapter.getModules !== 'function') return session.modules.active();
        const modules = await this.adapter.getModules();
        return Array.isArray(modules) ? modules : [];
      },
    });
    session.facets = Object.freeze({ ...session.facets, debugger: debuggerFacet });

    const originalClose = session.close.bind(session);
    session.close = async () => {
      if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch {} }
      unsubscribe = null;
      return originalClose();
    };
    session.newProviderEpoch = (reason = 'debugger-provider-epoch-changed') => {
      const next = session.newEpoch(reason);
      normalizer.resetEpoch(next);
      if (typeof this.adapter.setEpoch === 'function') this.adapter.setEpoch(next);
      else if (typeof this.adapter.nextEpoch === 'function') this.adapter.nextEpoch();
      return next;
    };
    return session;
  }
}

export function createDebuggerProvider(adapter, options = {}) {
  return new DebuggerProvider(adapter, options);
}
