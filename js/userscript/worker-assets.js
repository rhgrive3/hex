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
  const classicBlobURLs = [];

  /* A blob Worker is explicitly allowed by ChatGPT's worker-src policy. Avoid
     relying on a second CSP decision for importScripts(blob:...) inside that
     worker: inline the classic dependency graph into the entry blob instead.
     importScripts executes synchronously in the same global scope, so literal
     local dependencies preserve their execution order when expanded in place. */
  for (const path of manifest.classicEntries || []) {
    let source = inlineImportScripts(path, sources);
    source = capstonePrelude(wasmBlobURL) + '\n' + source;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    classicBlobURLs.push(url);
    workerURLs.set(path, url);
  }

  for (const [logicalPath, bundlePath] of Object.entries(manifest.moduleBundles || {})) {
    const response = await gmFetch(assetURL(base, bundlePath));
    if (!response.ok) throw new Error(`Could not load Hex module worker ${logicalPath} (${response.status}).`);
    const source = await response.text();
    workerURLs.set(logicalPath, URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
  }

  const runtime = installWorkerOverride(base, workerURLs, {
    revoke: [wasmBlobURL, ...classicBlobURLs, ...new Set(workerURLs.values())],
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
      for (const url of new Set(revoke)) {
        try { URL.revokeObjectURL(url); } catch { /* best effort */ }
      }
      if (globalThis.__HEX_WORKER_RUNTIME__ === runtime) delete globalThis.__HEX_WORKER_RUNTIME__;
    },
  };
  addEventListener('pagehide', () => runtime.cleanup(), { once: true });
  return runtime;
}

function inlineImportScripts(entryPath, sources, stack = []) {
  if (stack.includes(entryPath)) {
    throw new Error(`Hex classic worker importScripts cycle: ${[...stack, entryPath].join(' -> ')}`);
  }
  const source = sources.get(entryPath);
  if (source == null) throw new Error(`Hex worker source missing from manifest: ${entryPath}`);
  const nextStack = [...stack, entryPath];

  return String(source).replace(/\bimportScripts\s*\(([^;]*?)\)\s*;/gs, (_whole, args) => {
    const matches = [...String(args).matchAll(/(['"])([^'"]+)\1/g)];
    const residue = String(args)
      .replace(/(['"])([^'"]+)\1/g, '')
      .replace(/[\s,]/g, '');
    if (!matches.length || residue) {
      throw new Error(`Hex userscript only supports literal local importScripts arguments in ${entryPath}.`);
    }

    return matches.map((match) => {
      const specifier = match[2];
      if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier) || specifier.startsWith('//')) {
        throw new Error(`External importScripts dependency is not supported in ${entryPath}: ${specifier}`);
      }
      const resolved = resolveLogical(entryPath, specifier);
      const inlined = inlineImportScripts(resolved, sources, nextStack);
      return `\n/* Hex userscript inlined importScripts(${JSON.stringify(specifier)}) from ${entryPath}. */\n${inlined}\n`;
    }).join('\n');
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
