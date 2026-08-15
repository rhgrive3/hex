import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'userscript/hex.user.template.js');
const ORIGIN_TOKEN = '__HEX_ORIGIN__';

const [html, appCss, uxCss] = await Promise.all([
  readFile(resolve(root, 'index.html'), 'utf8'),
  readFile(resolve(root, 'css/app.css'), 'utf8'),
  readFile(resolve(root, 'css/ux.css'), 'utf8'),
]);

const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
if (!bodyMatch) throw new Error('index.html does not contain a body element.');
const body = bodyMatch[1]
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .trim();

const css = scopeCss(`${appCss}\n${uxCss}\n${userscriptCss()}`);
const banner = hostBootstrap(body, css);

const result = await build({
  absWorkingDir: root,
  entryPoints: ['js/userscript/entry.js'],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: ['safari17.4'],
  charset: 'utf8',
  legalComments: 'none',
  minify: false,
  sourcemap: false,
  banner: { js: banner },
  plugins: [remoteImportMetaPlugin()],
});

const js = result.outputFiles?.[0]?.text;
if (!js) throw new Error('esbuild did not produce a JavaScript bundle.');

const metadata = `// ==UserScript==\n` +
  `// @name         Hex for ChatGPT\n` +
  `// @namespace    https://github.com/rhgrive3/hex\n` +
  `// @version      1.0.0\n` +
  `// @description  Run the Hex binary analysis workbench on ChatGPT Web.\n` +
  `// @match        https://chatgpt.com/*\n` +
  `// @run-at       document-idle\n` +
  `// @grant        none\n` +
  `// @updateURL    ${ORIGIN_TOKEN}/hex.user.js\n` +
  `// @downloadURL  ${ORIGIN_TOKEN}/hex.user.js\n` +
  `// ==/UserScript==\n\n`;

await mkdir(dirname(output), { recursive: true });
await writeFile(output, metadata + js, 'utf8');
console.log(`built ${relative(root, output)} (${Buffer.byteLength(metadata + js)} bytes)`);

function remoteImportMetaPlugin() {
  return {
    name: 'hex-userscript-remote-import-meta',
    setup(buildApi) {
      buildApi.onLoad({ filter: /\.js$/ }, async (args) => {
        if (!args.path.startsWith(root)) return null;
        let source = await readFile(args.path, 'utf8');
        if (source.includes('import.meta.url')) {
          const rel = relative(root, args.path).split('\\').join('/');
          const remote = `${ORIGIN_TOKEN}/userscript-assets/${rel}`;
          source = source.replace(/\bimport\.meta\.url\b/g, JSON.stringify(remote));
        }
        return { contents: source, loader: 'js' };
      });
    },
  };
}

function scopeCss(source) {
  /* Hex's normal stylesheet intentionally targets html/body/:root. On ChatGPT
     that would restyle the host page and can break the composer. @scope keeps
     every ordinary rule inside the injected Hex subtree. Root selectors are
     translated to the scope root; global name-defining rules remain valid. */
  const translated = source
    .replace(/:root/g, ':scope')
    .replace(/\bhtml\s*,\s*body\b/g, ':scope');
  return `@scope (#hex-userscript-host) {\n${translated}\n}`;
}

function userscriptCss() {
  return `
:root {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100dvh;
  z-index: 2147483646;
  overflow: hidden;
  background: var(--bg);
  isolation: isolate;
}
.hex-userscript-controls {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}
.hex-provider-select {
  max-width: 142px;
  min-height: 34px;
  border: 0;
  border-radius: 8px;
  padding: 0 8px;
  background: var(--fill);
  color: var(--label);
  font: inherit;
}
.hex-host-toggle { font-size: 12px; }
`;
}

function hostBootstrap(bodyHtml, scopedCss) {
  const workerBridge = `(${installHexWorkerBridgeRuntime.toString()})(HEX_ORIGIN);`;
  return `(function(){\n` +
    `  if (location.hostname !== 'chatgpt.com') return;\n` +
    `  const HEX_ORIGIN = ${JSON.stringify(ORIGIN_TOKEN)};\n` +
    `  globalThis.__HEX_API_BASE__ = HEX_ORIGIN;\n` +
    `  ${workerBridge}\n` +
    `  if (!document.getElementById('hex-userscript-host')) {\n` +
    `    const host = document.createElement('div');\n` +
    `    host.id = 'hex-userscript-host';\n` +
    `    host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;visibility:hidden;pointer-events:none;background:#fff;';\n` +
    `    host.setAttribute('aria-hidden','true');\n` +
    `    host.innerHTML = ${JSON.stringify(bodyHtml)};\n` +
    `    const style = document.createElement('style');\n` +
    `    style.id = 'hex-userscript-style';\n` +
    `    style.textContent = ${JSON.stringify(scopedCss)};\n` +
    `    (document.head || document.documentElement).append(style);\n` +
    `    document.documentElement.append(host);\n` +
    `  }\n` +
    `})();`;
}

/* This function is stringified into the userscript banner. Keep it standalone:
   it intentionally has no closure dependencies. */
function installHexWorkerBridgeRuntime(origin) {
  const NativeWorker = globalThis.Worker;
  const NativeURL = globalThis.URL;
  if (!NativeWorker || NativeWorker.__hexWrapped) return;

  function workerBootstrap(remote, moduleWorker) {
    const setup = `
const __hexRemote = ${JSON.stringify(remote)};
const __HexNativeURL = globalThis.URL;
globalThis.URL = class HexRemoteURL extends __HexNativeURL {
  constructor(path, base) {
    let resolvedBase = base;
    if (typeof resolvedBase === 'string' && resolvedBase.startsWith('blob:') && typeof path === 'string') resolvedBase = __hexRemote;
    super(path, resolvedBase);
  }
};`;
    if (moduleWorker) return `${setup}\nimport(${JSON.stringify(remote)});`;
    return `${setup}
const __hexImportScripts = globalThis.importScripts.bind(globalThis);
globalThis.importScripts = (...urls) => __hexImportScripts(...urls.map((value) => new __HexNativeURL(String(value), __hexRemote).href));
__hexImportScripts(${JSON.stringify(remote)});`;
  }

  function HexWorker(url, options) {
    const href = new NativeURL(String(url), location.href).href;
    const prefix = origin + '/userscript-assets/';
    if (!href.startsWith(prefix)) return new NativeWorker(url, options);
    const bootstrap = workerBootstrap(href, !!(options && options.type === 'module'));
    const blobUrl = NativeURL.createObjectURL(new Blob([bootstrap], { type: 'text/javascript' }));
    try { return new NativeWorker(blobUrl, options); }
    finally { setTimeout(() => NativeURL.revokeObjectURL(blobUrl), 1000); }
  }

  HexWorker.prototype = NativeWorker.prototype;
  Object.setPrototypeOf(HexWorker, NativeWorker);
  Object.defineProperty(HexWorker, '__hexWrapped', { value: true });
  globalThis.Worker = HexWorker;
}
