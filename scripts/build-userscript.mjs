import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, posix, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'userscript/hex.user.template.js');
const platformWorkerOutput = resolve(root, 'userscript/platform-worker.bundle.js');
const ORIGIN_TOKEN = '__HEX_ORIGIN__';
const CLASSIC_ENTRIES = [
  'js/worker.js',
  'js/platform/capstone-probe-worker.js',
  'js/platform/capstone-disasm-worker.js',
];

const [html, appCss, uxCss, classicManifest, platformWorker] = await Promise.all([
  readFile(resolve(root, 'index.html'), 'utf8'),
  readFile(resolve(root, 'css/app.css'), 'utf8'),
  readFile(resolve(root, 'css/ux.css'), 'utf8'),
  collectClassicManifest(CLASSIC_ENTRIES),
  buildPlatformWorker(),
]);

const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
if (!bodyMatch) throw new Error('index.html does not contain a body element.');
const body = bodyMatch[1]
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .trim();

const workerManifest = {
  classicEntries: CLASSIC_ENTRIES,
  classicAssets: classicManifest.assets,
  classicDependencies: classicManifest.dependencies,
  moduleBundles: { 'js/platform/worker.js': 'userscript/platform-worker.bundle.js' },
  wasm: 'capstone.wasm',
};
const css = scopeCss(`${appCss}\n${uxCss}\n${userscriptCss()}`);
const banner = hostBootstrap(body, css, workerManifest);

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

const version = userscriptVersion();
const metadata = `// ==UserScript==\n` +
  `// @name         Hex for ChatGPT\n` +
  `// @namespace    https://github.com/rhgrive3/hex\n` +
  `// @version      ${version}\n` +
  `// @description  Run the Hex binary analysis workbench on ChatGPT Web.\n` +
  `// @match        https://chatgpt.com/*\n` +
  `// @run-at       document-idle\n` +
  `// @inject-into  content\n` +
  `// @grant        GM.xmlHttpRequest\n` +
  `// @updateURL    ${ORIGIN_TOKEN}/hex.meta.js\n` +
  `// @downloadURL  ${ORIGIN_TOKEN}/hex.user.js\n` +
  `// ==/UserScript==\n\n`;

await mkdir(dirname(output), { recursive: true });
await Promise.all([
  writeFile(output, metadata + js, 'utf8'),
  writeFile(platformWorkerOutput, platformWorker, 'utf8'),
]);
console.log(`built ${relative(root, output)} (${Buffer.byteLength(metadata + js)} bytes)`);
console.log(`built ${relative(root, platformWorkerOutput)} (${Buffer.byteLength(platformWorker)} bytes)`);

async function buildPlatformWorker() {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['js/platform/worker.js'],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['safari17.4'],
    charset: 'utf8',
    legalComments: 'none',
    minify: false,
    sourcemap: false,
  });
  const source = result.outputFiles?.[0]?.text;
  if (!source) throw new Error('esbuild did not produce the platform worker bundle.');
  return source;
}

async function collectClassicManifest(entries) {
  const dependencies = {};
  const seen = new Set();

  const visit = async (path) => {
    path = normalizeRepoPath(path);
    if (seen.has(path)) return;
    seen.add(path);
    const source = await readFile(resolve(root, path), 'utf8');
    const deps = parseImportScripts(source, path);
    dependencies[path] = deps;
    for (const dependency of deps) await visit(dependency);
  };

  for (const entry of entries) await visit(entry);
  return { assets: [...seen], dependencies };
}

function parseImportScripts(source, sourcePath) {
  const out = [];
  for (const call of source.matchAll(/\bimportScripts\s*\(([^;]*?)\)\s*;/gs)) {
    const args = call[1];
    for (const literal of args.matchAll(/(['"])([^'"]+)\1/g)) {
      const specifier = literal[2];
      if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier) || specifier.startsWith('//')) {
        throw new Error(`External importScripts dependency is not supported in userscript workers: ${specifier}`);
      }
      const resolved = normalizeRepoPath(posix.join(posix.dirname(sourcePath), specifier));
      if (!out.includes(resolved)) out.push(resolved);
    }
  }
  return out;
}

function normalizeRepoPath(path) {
  const normalized = posix.normalize(String(path).replaceAll('\\', '/')).replace(/^\.\//, '').replace(/^\//, '');
  if (!normalized || normalized === '..' || normalized.startsWith('../')) throw new Error(`Worker asset escapes repository root: ${path}`);
  return normalized;
}

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

function hostBootstrap(bodyHtml, scopedCss, workerManifest) {
  return `(function(){\n` +
    `  if (location.hostname !== 'chatgpt.com') return;\n` +
    `  const HEX_ORIGIN = ${JSON.stringify(ORIGIN_TOKEN)};\n` +
    `  globalThis.__HEX_API_BASE__ = HEX_ORIGIN;\n` +
    `  globalThis.__HEX_WORKER_MANIFEST__ = ${JSON.stringify(workerManifest)};\n` +
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

function userscriptVersion() {
  try {
    /* Generated bundles are committed so Cloudflare can serve them directly.
       Excluding those files makes a rebuild on the generated commit produce
       the exact same @version instead of creating an endless self-update. */
    const stamp = execFileSync('git', [
      'log', '-1', '--format=%ct', '--', '.',
      ':(exclude)userscript/hex.user.template.js',
      ':(exclude)userscript/platform-worker.bundle.js',
    ], { cwd: root, encoding: 'utf8' }).trim();
    if (/^\d+$/.test(stamp)) return `1.0.${stamp}`;
  } catch { /* deterministic fallback for source archives */ }
  return '1.0.0';
}
