import { gmFetch } from './network.js';

export async function prepareUserscriptWorkers({
  origin = globalThis.__HEX_API_BASE__,
  manifest = globalThis.__HEX_WORKER_MANIFEST__,
} = {}) {
  if (globalThis.__HEX_WORKER_RUNTIME__) return globalThis.__HEX_WORKER_RUNTIME__;
  if (!origin || !manifest) throw new Error('Hex userscript worker manifest is unavailable.');

  const base = new URL(String(origin));
  const classicPaths = [...new Set(manifest.classicAssets || [])];
  const sourceEntries = await Promise.all(classicPaths.map(async (path) => {
    const response = await gmFetch(assetURL(base, path));
    if (!response.ok) throw new Error(`Could not load Hex worker asset ${path} (${response.status}).`);
    return [path, await response.text()];
  }));
  const sources = new Map(sourceEntries);

  const wasmResponse = await gmFetch(assetURL(base, manifest.wasm || 'capstone.wasm'));
  if (!wasmResponse.ok) throw new Error(`Could not load capstone.wasm (${wasmResponse.status}).`);
  const wasmBlobURL = URL.createObjectURL(new Blob([await wasmResponse.arrayBuffer()], { type: 'application/wasm' }));

  const workerURLs = new Map();
  const classicURLs = new Map();
  const dependencies = manifest.classicDependencies || {};
  const classicEntries = new Set(manifest.classicEntries || []);

  const buildClassic = (path) => {
    if (classicURLs.has(path)) return classicURLs.get(path);
    if (!sources.has(path)) throw new Error(`Hex worker source missing from manifest: ${path}`);
    for (const dependency of dependencies[path] || []) buildClassic(dependency);

    let source = rewriteImportScripts(sources.get(path), path, classicURLs);
    if (classicEntries.has(path)) source = capstonePrelude(wasmBlobURL) + '\n' + source;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    classicURLs.set(path, url);
    return url;
  };

  for (const path of manifest.classicEntries || []) workerURLs.set(path, buildClassic(path));

  for (const [logicalPath, bundlePath] of Object.entries(manifest.moduleBundles || {})) {
    const response = await gmFetch(assetURL(base, bundlePath));
    if (!response.ok) throw new Error(`Could not load Hex module worker ${logicalPath} (${response.status}).`);
    const source = await response.text();
    workerURLs.set(logicalPath, URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
  }

  const runtime = installWorkerOverride(base, workerURLs, {
    revoke: [wasmBlobURL, ...new Set([...classicURLs.values(), ...workerURLs.values()])],
  });
  globalThis.__HEX_WORKER_RUNTIME__ = runtime;
  return runtime;
}

function installWorkerOverride(base, workerURLs, { revoke = [] } = {}) {
  const NativeWorker = globalThis.Worker;
  if (!NativeWorker) throw new Error('Web Workers are unavailable in this browser.');
  if (NativeWorker.__hexUserscriptWorker) return globalThis.__HEX_WORKER_RUNTIME__;

  function HexWorker(url, options) {
    const logical = logicalPath(url, base);
    const local = logical ? workerURLs.get(logical) : null;
    if (!local) return new NativeWorker(url, options);
    return new NativeWorker(local, options);
  }
  HexWorker.prototype = NativeWorker.prototype;
  Object.setPrototypeOf(HexWorker, NativeWorker);
  Object.defineProperty(HexWorker, '__hexUserscriptWorker', { value: true });
  globalThis.Worker = HexWorker;

  let cleaned = false;
  const runtime = {
    nativeWorker: NativeWorker,
    workers: workerURLs,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (globalThis.Worker === HexWorker) globalThis.Worker = NativeWorker;
      for (const url of revoke) {
        try { URL.revokeObjectURL(url); } catch { /* best effort */ }
      }
      if (globalThis.__HEX_WORKER_RUNTIME__ === runtime) delete globalThis.__HEX_WORKER_RUNTIME__;
    },
  };
  addEventListener('pagehide', () => runtime.cleanup(), { once: true });
  return runtime;
}

function rewriteImportScripts(source, sourcePath, blobURLs) {
  return String(source).replace(/\bimportScripts\s*\(([^;]*?)\)\s*;/gs, (whole, args) => {
    const rewritten = args.replace(/(['"])([^'"]+)\1/g, (literal, _quote, specifier) => {
      const resolved = resolveLogical(sourcePath, specifier);
      const blob = blobURLs.get(resolved);
      if (!blob) throw new Error(`Hex worker dependency ${specifier} from ${sourcePath} was not preloaded.`);
      return JSON.stringify(blob);
    });
    return `importScripts(${rewritten});`;
  });
}

function resolveLogical(fromPath, specifier) {
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier)) return specifier;
  const base = new URL('/' + fromPath.replace(/^\/+/, ''), 'https://hex.invalid');
  return new URL(specifier, base).pathname.replace(/^\//, '');
}

function logicalPath(value, base) {
  try {
    const url = new URL(String(value), location.href);
    const prefix = '/userscript-assets/';
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) return null;
    return decodeURIComponent(url.pathname.slice(prefix.length));
  } catch { return null; }
}

function assetURL(base, path) {
  return new URL('/userscript-assets/' + String(path).replace(/^\/+/, ''), base).href;
}

function capstonePrelude(wasmBlobURL) {
  return `
;(() => {
  const __HexNativeURL = globalThis.URL;
  const __hexWasmURL = ${JSON.stringify(wasmBlobURL)};
  globalThis.URL = class HexWorkerURL extends __HexNativeURL {
    constructor(path, base) {
      if (typeof path === 'string' && /(?:^|\\/)capstone\\.wasm(?:[?#].*)?$/.test(path)) {
        super(__hexWasmURL);
        return;
      }
      super(path, base);
    }
  };
})();`;
}
