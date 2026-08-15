import assert from 'node:assert/strict';
import fs from 'node:fs';

const app = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');

assert.match(app, /import\s*\{[^}]*buildObjcRuntimeModel[^}]*buildObjcRuntimeIndex[^}]*\}\s*from\s*['"]\.\/objc\.js['"]/s);
assert.match(app, /import\s*\{[^}]*buildSwiftMetadataModel[^}]*buildSwiftRuntimeIndex[^}]*resolveSwiftDispatch[^}]*\}\s*from\s*['"]\.\/swift\.js['"]/s);
assert.match(app, /import\s*\{[^}]*rankApplicationFunctions[^}]*\}\s*from\s*['"]\.\/recognition\/classifier\.js['"]/s);
assert.match(app, /import\s*\{[^}]*KnowledgeDB[^}]*\}\s*from\s*['"]\.\/knowledge\/index\.js['"]/s);

for (const identifier of [
  'buildObjcRuntimeIndex', 'buildSwiftMetadataModel', 'buildSwiftRuntimeIndex',
  'resolveSwiftDispatch', 'rankApplicationFunctions', 'KnowledgeDB',
]) {
  const uses = app.match(new RegExp(`\\b${identifier}\\b`, 'g')) || [];
  assert.ok(uses.length >= 2, `${identifier} must be imported and actually used`);
}

console.log('runtime intelligence import wiring: PASS');
