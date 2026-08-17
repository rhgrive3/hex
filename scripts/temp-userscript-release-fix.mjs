import fs from 'node:fs';

const path = 'scripts/build-userscript.mjs';
let text = fs.readFileSync(path, 'utf8');

function replaceOnce(oldText, newText, label) {
  if (!text.includes(oldText)) throw new Error(`Missing build patch anchor: ${label}`);
  if (text.indexOf(oldText) !== text.lastIndexOf(oldText)) throw new Error(`Non-unique build patch anchor: ${label}`);
  text = text.replace(oldText, newText);
}

replaceOnce(
`import { fileURLToPath } from 'node:url';
`,
`import { fileURLToPath } from 'node:url';
import { resolveUserscriptReleaseVersion } from './userscript-release-version.mjs';
`,
'import release helper',
);
replaceOnce(
`const LOADER_VERSION = '2.0.2322241684';
`,
`const releaseStatePath = resolve(root, 'userscript/release-version.json');
`,
'remove fixed loader version',
);
replaceOnce(
`const runtime = await bundle('js/userscript/protected-entry.js', { format: 'esm', rewriteImportMeta: true });
const contentHash = sha256(runtime), buildId = contentHash.slice(0, 24);
const compressed = gzipSync(runtime, { level: 9 });
`,
`const runtime = await bundle('js/userscript/protected-entry.js', { format: 'esm', rewriteImportMeta: true });
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
if (release.changed) await writeFile(releaseStatePath, `${JSON.stringify(release.state, null, 2)}\\n`);
const compressed = gzipSync(runtime, { level: 9 });
`,
'compute release identity and monotonic version',
);
replaceOnce(
`const loaderBundle = await bundle('js/userscript/loader.js', { format: 'iife' });
const loaderForOrigin = (origin) => loaderBundle.toString('utf8')
`,
`const loaderForOrigin = (origin) => loaderBundle.toString('utf8')
`,
'reuse earlier loader bundle',
);
replaceOnce(
`console.log(` + '`built tiny userscript loader (${Buffer.byteLength(template)} bytes)`' + `);
`,
`console.log(` + '`built tiny userscript loader ${LOADER_VERSION} (${Buffer.byteLength(template)} bytes)`' + `);
console.log(` + '`userscript release identity ${releaseIdentity}${release.changed ? " (version advanced)" : ""}`' + `);
`,
'build diagnostics',
);
fs.writeFileSync(path, text);

fs.writeFileSync('scripts/userscript-release-version.mjs', `const VERSION_PREFIX = '2.0';
const IDENTITY = /^[a-f0-9]{64}$/;
const BUILD_ID = /^[a-f0-9]{24}$/;

export function resolveUserscriptReleaseVersion(previous, { releaseIdentity, buildId } = {}) {
  const serial = Number(previous?.serial);
  if (!Number.isSafeInteger(serial) || serial < 1 || serial >= 9_999_999_999) {
    throw new Error('Userscript release serial is invalid or exhausted.');
  }
  const identity = String(releaseIdentity || '').toLowerCase();
  const runtimeBuildId = String(buildId || '').toLowerCase();
  if (!IDENTITY.test(identity)) throw new Error('Userscript release identity must be SHA-256 hex.');
  if (!BUILD_ID.test(runtimeBuildId)) throw new Error('Userscript runtime buildId must be 24 lowercase hex characters.');

  const unchanged = previous?.releaseIdentity === identity && previous?.buildId === runtimeBuildId;
  const nextSerial = unchanged ? serial : serial + 1;
  const state = Object.freeze({ serial: nextSerial, releaseIdentity: identity, buildId: runtimeBuildId });
  return Object.freeze({
    changed: !unchanged,
    version: `${VERSION_PREFIX}.${nextSerial}`,
    state,
  });
}
`);

fs.mkdirSync('userscript', { recursive: true });
fs.writeFileSync('userscript/release-version.json', JSON.stringify({
  serial: 2322241684,
  releaseIdentity: 'legacy:def764232cd999ceabc4e88e',
  buildId: 'def764232cd999ceabc4e88e',
}, null, 2) + '\n');

fs.writeFileSync('tests/userscript-release-version.mjs', `import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveUserscriptReleaseVersion } from '../scripts/userscript-release-version.mjs';

const a = 'a'.repeat(64), b = 'b'.repeat(64);
const buildA = '1'.repeat(24), buildB = '2'.repeat(24);
const same = resolveUserscriptReleaseVersion({ serial: 41, releaseIdentity: a, buildId: buildA }, { releaseIdentity: a, buildId: buildA });
assert.equal(same.version, '2.0.41');
assert.equal(same.changed, false);
assert.equal(same.state.serial, 41);

const runtimeChange = resolveUserscriptReleaseVersion(same.state, { releaseIdentity: b, buildId: buildB });
assert.equal(runtimeChange.version, '2.0.42');
assert.equal(runtimeChange.changed, true);
assert.equal(runtimeChange.state.serial, 42);

const loaderOnlyChange = resolveUserscriptReleaseVersion({ serial: 42, releaseIdentity: b, buildId: buildB }, { releaseIdentity: a, buildId: buildB });
assert.equal(loaderOnlyChange.version, '2.0.43', 'loader/release identity changes must bump even when runtime buildId is unchanged');

assert.throws(() => resolveUserscriptReleaseVersion({ serial: 0 }, { releaseIdentity: a, buildId: buildA }));
assert.throws(() => resolveUserscriptReleaseVersion({ serial: 41, releaseIdentity: a, buildId: buildA }, { releaseIdentity: 'bad', buildId: buildA }));

const releaseState = JSON.parse(fs.readFileSync(new URL('../userscript/release-version.json', import.meta.url), 'utf8'));
const template = fs.readFileSync(new URL('../userscript/hex.user.template.js', import.meta.url), 'utf8');
const version = /^\\/\\/ @version\\s+(\\S+)/m.exec(template)?.[1];
const buildId = /__HEX_SECURE_LOADER__=\\{version:[^,]+,buildId:([A-Za-z_$][\\w$]*|"[a-f0-9]{24}")\\}/.exec(template);
assert.equal(version, `2.0.${releaseState.serial}`, 'committed userscript metadata must match release-version state');
assert.match(releaseState.releaseIdentity, /^[a-f0-9]{64}$/);
assert.match(releaseState.buildId, /^[a-f0-9]{24}$/);
assert.ok(template.includes(releaseState.buildId), 'committed userscript loader must embed the release state buildId');
console.log('Userscript release-version contract passed');
`);

const packagePath = 'package.json';
let pkg = fs.readFileSync(packagePath, 'utf8');
const old = `node tests/userscript-embed-protocol.mjs`;
const replacement = `node tests/userscript-release-version.mjs && node tests/userscript-embed-protocol.mjs`;
if (!pkg.includes(old)) throw new Error('package userscript:test anchor missing');
pkg = pkg.replace(old, replacement);
fs.writeFileSync(packagePath, pkg);

console.log('Userscript release-version repair staged.');
