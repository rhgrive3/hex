import assert from 'node:assert/strict';
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
const version = /^\/\/ @version\s+(\S+)/m.exec(template)?.[1];
assert.equal(version, '2.0.' + releaseState.serial, 'committed userscript metadata must match release-version state');
assert.match(releaseState.releaseIdentity, /^[a-f0-9]{64}$/);
assert.match(releaseState.buildId, /^[a-f0-9]{24}$/);
assert.ok(template.includes(releaseState.buildId), 'committed userscript loader must embed the release state buildId');
await import('./userscript-deployment-identity.mjs');
console.log('Userscript release-version contract passed');
