import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const paths=[
  'index.html','css','js','capstone.js','capstone.wasm','package.json','package-lock.json','scripts/build-userscript.mjs',
];
const expected=execFileSync('git',['log','--no-merges','-1','--format=%ct','--',...paths],{encoding:'utf8'}).trim();
assert.match(expected,/^\d+$/);
const source=fs.readFileSync(new URL('../userscript/hex.user.template.js',import.meta.url),'utf8');
const match=/^\/\/ @version\s+1\.0\.(\d+)$/m.exec(source);
assert.ok(match,'userscript must contain a numeric 1.0.<source epoch> version');
assert.equal(match[1],expected,'userscript version must follow the latest non-merge source commit');

const build=fs.readFileSync(new URL('../scripts/build-userscript.mjs',import.meta.url),'utf8');
assert.match(build,/'log', '--no-merges', '-1', '--format=%ct'/,
  'merge commits must not invalidate an otherwise current userscript bundle');
console.log('userscript merge-stable version regression: PASS');
