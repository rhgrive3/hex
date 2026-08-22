import { ResourceBudget } from './index.js';

function abortError(signal) {
  return signal?.reason ?? new DOMException('Aborted', 'AbortError');
}

export function createSchedulerBudget(candidate, defaultLimits = {}, signal = null) {
  const base = candidate instanceof ResourceBudget
    ? candidate
    : new ResourceBudget({ ...defaultLimits, ...(candidate || {}) });
  if (!signal) return base;

  const checkCancelled = () => {
    if (signal.aborted) throw abortError(signal);
    base.checkCancelled();
  };
  return new Proxy(base, {
    get(target, property) {
      if (property === 'checkCancelled') return checkCancelled;
      if (property === 'consume') return (resource, amount = 1) => {
        checkCancelled();
        return base.consume(resource, amount);
      };
      if (property === 'scope') return (name, limits = {}, options = {}) =>
        createSchedulerBudget(base.scope(name, limits, options), {}, signal);
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
