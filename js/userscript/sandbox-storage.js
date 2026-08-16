export function installOpaqueSandboxStorage(globalObject = globalThis) {
  const localStorage = installStorage(globalObject, 'localStorage');
  const sessionStorage = installStorage(globalObject, 'sessionStorage');
  return Object.freeze({ localStorage, sessionStorage });
}

export function createMemoryStorage() {
  const values = new Map();
  const storage = {
    get length() { return values.size; },
    key(index) {
      const number = Number(index);
      if (!Number.isInteger(number) || number < 0) return null;
      return [...values.keys()][number] ?? null;
    },
    getItem(key) {
      const normalized = String(key);
      return values.has(normalized) ? values.get(normalized) : null;
    },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    clear() { values.clear(); },
  };
  return Object.freeze(storage);
}

function installStorage(globalObject, name) {
  try {
    const current = globalObject[name];
    if (isUsableStorage(current)) return current;
  } catch {}

  const storage = createMemoryStorage();
  if (defineStorage(globalObject, name, storage) && readInstalledStorage(globalObject, name) === storage) return storage;

  let prototype = null;
  try { prototype = Object.getPrototypeOf(globalObject); } catch {}
  if (prototype && defineStorage(prototype, name, storage) && readInstalledStorage(globalObject, name) === storage) return storage;

  throw new Error(`${name} cannot be isolated inside the opaque Hex sandbox.`);
}

function defineStorage(target, name, storage) {
  try {
    Object.defineProperty(target, name, {
      value: storage,
      configurable: true,
      enumerable: true,
      writable: false,
    });
    return true;
  } catch { return false; }
}

function readInstalledStorage(globalObject, name) {
  try { return globalObject[name]; } catch { return null; }
}

function isUsableStorage(value) {
  if (!value || typeof value.getItem !== 'function' || typeof value.setItem !== 'function') return false;
  try { void value.length; return true; } catch { return false; }
}
