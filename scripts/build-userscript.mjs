import { build, transform } from 'esbuild';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveUserscriptReleaseVersion } from './userscript-release-version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const generated = resolve(root, '.runtime-build');
const committedTemplate = resolve(root, 'userscript/hex.user.template.js');
const deploymentIdentityStamp = resolve(root, 'js/userscript/deployment-identity.generated.js');
const ORIGIN_TOKEN = '__HEX_ORIGIN__';
const releaseStatePath = resolve(root, 'userscript/release-version.json');
const MAX_LOADER_BYTES = 64 * 1024;
const CLASSIC_ENTRIES = ['js/worker.js', 'js/platform/capstone-probe-worker.js', 'js/platform/capstone-disasm-worker.js'];
const MODULE_WORKER_ENTRIES = ['js/platform/worker.js', 'js/symbolic/solver/worker-entry.js'];

await Promise.all([rm(dist, { recursive: true, force: true }), rm(generated, { recursive: true, force: true })]);
await Promise.all([mkdir(resolve(dist, 'assets'), { recursive: true }), mkdir(resolve(dist, '.runtime'), { recursive: true }), mkdir(resolve(dist, 'userscript'), { recursive: true }), mkdir(generated, { recursive: true })]);
await writeFile(deploymentIdentityStamp, '// Cloudflare Workers Builds overwrites this file during the production build.\n// Local/test builds intentionally remain unbound to a deployment commit.\nexport const DEPLOYMENT_COMMIT = null;\n');

const [htmlSource, css, workerAssets] = await Promise.all([readFile(resolve(root, 'index.html'), 'utf8'), bundleCss(), buildWorkerAssets()]);
const body = extractBody(htmlSource);
const scopedCss = scopeCss(css);
await writeGeneratedModule('embedded-assets.js', `export const PROTECTED_HOST=${JSON.stringify({ html: body, css, scopedCss })};\nexport const PROTECTED_WORKER_ASSETS=${JSON.stringify(workerAssets)};\n`);

const runtime = await bundle('js/userscript/protected-entry.js', { format: 'esm', rewriteImportMeta: true });
const loaderBundle = await bundle('js/userscript/loader.js', { format: 'iife' });
const contentHash = sha256(runtime), buildId = contentHash.slice(0, 24);
const releaseIdentity = sha256(Buffer.concat([
  Buffer.from(contentHash, 'utf8'),
  Buffer.from(sha256(loaderBundle), 'utf8'),
  await readFile(fileURLToPath(import.meta.url)),
]));
const previousRelease = JSON.parse(await readFile(releaseStatePath, 'utf8'));
const release = resolveUserscriptReleaseVersion(previousRelease, { releaseIdentity, buildId });
const LOADER_VERSION = release.version;
if (release.changed) await writeFile(releaseStatePath, JSON.stringify(release.state, null, 2) + '\n');
const compressed = gzipSync(runtime, { level: 9 });
const contentKey = randomBytes(32), iv = randomBytes(12);
const runtimeVersion = `2.${LOADER_VERSION}`;
const aad = `hex-runtime:${buildId}:${runtimeVersion}`;
const cipher = createCipheriv('aes-256-gcm', contentKey, iv); cipher.setAAD(Buffer.from(aad));
const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final(), cipher.getAuthTag()]);
const assetPath = `/.runtime/runtime.${buildId}.bin`;
const manifest = Object.freeze({ buildId, runtimeVersion, ciphertextHash: sha256(ciphertext), contentHash, iv: b64(iv), aad, compression: 'gzip', assetPath, byteLength: ciphertext.length });
await writeFile(resolve(dist, assetPath.slice(1)), ciphertext);
await writeGeneratedModule('runtime-secrets.js', `export const RUNTIME_BUILD=Object.freeze(${JSON.stringify({ manifest, contentKey: b64(contentKey), signingKey: b64(randomBytes(32)) })});\n`);

const loaderForOrigin = (origin) => loaderBundle.toString('utf8')
  .replaceAll(ORIGIN_TOKEN, origin)
  .replaceAll('__HEX_LOADER_VERSION__', LOADER_VERSION)
  .replaceAll('__HEX_BUILD_ID__', buildId);
const publicLoader = loaderForOrigin('https://ida.rhgrive.workers.dev');
if (Buffer.byteLength(publicLoader) > MAX_LOADER_BYTES) throw new Error(`Tiny loader exceeds ${MAX_LOADER_BYTES} bytes.`);
const loaderName = `loader.${sha256(publicLoader).slice(0, 12)}.js`;
await writeFile(resolve(dist, 'assets', loaderName), publicLoader);

const metadata = userscriptMetadata();
const template = metadata + loaderForOrigin(ORIGIN_TOKEN);
if (Buffer.byteLength(template) > MAX_LOADER_BYTES) throw new Error(`hex.user.js template exceeds ${MAX_LOADER_BYTES} bytes.`);
await Promise.all([writeFile(resolve(dist, 'userscript/hex.user.template.js'), template), writeFile(committedTemplate, template)]);

const index = standaloneIndex(htmlSource, `/assets/${loaderName}`);
await writeFile(resolve(dist, 'index.html'), index);
await writeFile(resolve(dist, 'runtime-manifest.json'), JSON.stringify(publicManifest(manifest), null, 2));

console.log(`built tiny userscript loader ${LOADER_VERSION} (${Buffer.byteLength(template)} bytes)`);
console.log(`userscript release identity ${releaseIdentity}${release.changed ? " (version advanced)" : ""}`);
console.log(`built protected runtime ${buildId} (${runtime.length} -> ${ciphertext.length} bytes)`);
console.log(`built dist/ with ${manifest.ciphertextHash}`);

async function bundleCss() {
  const result = await build({ absWorkingDir: root, stdin: { contents: '@import "./css/app.css";\n@import "./css/ux.css";', resolveDir: root, loader: 'css' }, bundle: true, write: false, minify: true, sourcemap: false, legalComments: 'none', target: ['safari17.4'] });
  const output = result.outputFiles?.find((file) => file.path.endsWith('.css')) || result.outputFiles?.[0];
  if (!output) throw new Error('CSS bundling produced no output.');
  return output.text;
}

async function bundle(entry, { format = 'iife', rewriteImportMeta = false } = {}) {
  const result = await build({ absWorkingDir: root, entryPoints: [entry], bundle: true, write: false, format, platform: 'browser', target: ['safari17.4'], charset: 'utf8', legalComments: 'none', minify: true, minifyIdentifiers: true, minifySyntax: true, minifyWhitespace: true, sourcemap: false, plugins: rewriteImportMeta ? [protectedImportMetaPlugin()] : [] });
  const source = result.outputFiles?.[0]?.contents;
  if (!source) throw new Error(`esbuild produced no output for ${entry}`);
  return Buffer.from(source);
}

function protectedImportMetaPlugin() {
  return { name: 'hex-protected-import-meta', setup(api) {
    api.onLoad({ filter: /\.js$/ }, async (args) => {
      if (!args.path.startsWith(root)) return null;
      let source = await readFile(args.path, 'utf8');
      if (!source.includes('import.meta.url')) return null;
      const logical = relative(root, args.path).split('\\').join('/');
      source = source.replace(/\bimport\.meta\.url\b/g, JSON.stringify(`https://hex.invalid/${logical}`));
      return { contents: source, loader: 'js' };
    });
  } };
}

async function buildWorkerAssets() {
  const sources = new Map();
  for (const entry of CLASSIC_ENTRIES) await collectClassic(entry, sources);
  const classic = {};
  for (const entry of CLASSIC_ENTRIES) {
    const minified = await transform(inlineImports(entry, sources), { loader: 'js', target: 'safari17.4', minify: true, legalComments: 'none', sourcemap: false });
    classic[entry] = minified.code;
  }
  const modules = {
    [MODULE_WORKER_ENTRIES[0]]: (await bundle(MODULE_WORKER_ENTRIES[0], { format: 'iife' })).toString('utf8'),
  };
  for (const entry of MODULE_WORKER_ENTRIES.slice(1)) {
    modules[entry] = (await bundle(entry, { format: 'esm' })).toString('utf8');
  }
  const wasm = await readFile(resolve(root, 'capstone.wasm'));
  return { classic, modules, wasm: wasm.toString('base64') };
}
async function collectClassic(path, sources) {
  path = normalizePath(path); if (sources.has(path)) return;
  const source = await readFile(resolve(root, path), 'utf8'); sources.set(path, source);
  for (const dependency of parseImports(source, path)) await collectClassic(dependency, sources);
}
function parseImports(source, from) {
  const out = [];
  for (const call of source.matchAll(/\bimportScripts\s*\(([^;]*?)\)\s*;/gs)) for (const match of call[1].matchAll(/(['"])([^'"]+)\1/g)) out.push(normalizePath(posix.join(posix.dirname(from), match[2])));
  return out;
}
function inlineImports(path, sources, stack = []) {
  if (stack.includes(path)) throw new Error(`Worker import cycle: ${[...stack, path].join(' -> ')}`);
  const source = sources.get(path); if (source == null) throw new Error(`Missing worker source: ${path}`);
  return source.replace(/\bimportScripts\s*\(([^;]*?)\)\s*;/gs, (_all, args) => [...args.matchAll(/(['"])([^'"]+)\1/g)].map((match) => inlineImports(normalizePath(posix.join(posix.dirname(path), match[2])), sources, [...stack, path])).join('\n'));
}
function normalizePath(value) { const path = posix.normalize(String(value).replaceAll('\\', '/')).replace(/^\.\//, '').replace(/^\//, ''); if (!path || path.startsWith('../')) throw new Error(`Path escapes repository: ${value}`); return path; }

function extractBody(html) { const match = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i); if (!match) throw new Error('index.html has no body'); return match[1].replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').trim(); }
function standaloneIndex(html, loaderPath) { return html.replace(/<link\s+rel="stylesheet"\s+href="\.\/css\/(?:app|ux)\.css">\s*/g, '').replace(/<script\s+type="module"\s+src="\.\/js\/(?:app|ux)\.js"><\/script>\s*/g, '').replace('</body>', `<script type="module" src="${loaderPath}"></script>\n</body>`); }
function scopeCss(source) {
  const translated = source
    .replace(/(^|[{},])\s*:root\b/g, '$1:scope')
    .replace(/(^|[{},])\s*html(?=[\s.#:[,{>+~])/g, '$1:scope')
    .replace(/(^|[{},])\s*body(?=[\s.#:[,{>+~])/g, '$1:scope');
  return `@scope (#hex-userscript-host){${translated}}#hex-userscript-host{position:fixed;inset:0;width:100vw;height:100dvh;z-index:2147483646;overflow:hidden;background:var(--bg);isolation:isolate}`;
}
function userscriptMetadata() { return `// ==UserScript==\n// @name         Hex for ChatGPT\n// @namespace    https://github.com/rhgrive3/hex\n// @version      ${LOADER_VERSION}\n// @description  Securely load the Hex binary analysis workbench on ChatGPT Web.\n// @match        https://chatgpt.com/*\n// @run-at       document-start\n// @inject-into  content\n// @grant        GM.xmlHttpRequest\n// @connect      ida.rhgrive.workers.dev\n// @updateURL    ${ORIGIN_TOKEN}/hex.meta.js\n// @downloadURL  ${ORIGIN_TOKEN}/hex.user.js\n// ==/UserScript==\n\n`; }
function publicManifest(value) { const { assetPath: _private, ...safe } = value; return safe; }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function b64(value) { return Buffer.from(value).toString('base64url'); }
async function writeGeneratedModule(name, source) { const path = resolve(generated, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, source); }
