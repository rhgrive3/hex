import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeArchitectureNeutralSource, scanArchitectureNeutrality } from '../../tools/validation/semantic-v2/architecture-neutrality.mjs';

const allowed = `
// import bad from '../../targets/architecture/arm64/index.js';
export function passOpaque(metadata) {
  const payload = { architecture: 'arm64', register: 'x0', flag: 'NZCV' };
  return metadata.consume(payload);
}
`;
assert.deepEqual(analyzeArchitectureNeutralSource(allowed), []);

const badImport = `import { lift } from '../../targets/architecture/arm64/effects/index.js';\nexport { lift };`;
assert.equal(analyzeArchitectureNeutralSource(badImport).some((item) => item.kind === 'target-architecture-import'), true);

const badBranch = `export function f(architectureId) { if (architectureId === 'arm64') return 1; return 0; }`;
assert.equal(analyzeArchitectureNeutralSource(badBranch).some((item) => item.kind === 'target-specific-branch' || item.kind === 'target-specific-comparison'), true);

const badFlag = `export function f(state) { return state.NZCV; }`;
assert.equal(analyzeArchitectureNeutralSource(badFlag).some((item) => item.kind === 'target-specific-state'), true);

const badSwitch = `export function f(kind) { switch (kind) { case 'x86_64': return 1; default: return 0; } }`;
assert.equal(analyzeArchitectureNeutralSource(badSwitch).some((item) => item.kind === 'target-specific-branch'), true);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-arch-gate-'));
fs.mkdirSync(path.join(root, 'js/semantics/ssa'), { recursive:true });
fs.mkdirSync(path.join(root, 'js/semantics/memoryssa'), { recursive:true });
fs.writeFileSync(path.join(root, 'js/semantics/ssa/build.js'), allowed);
fs.writeFileSync(path.join(root, 'js/semantics/memoryssa/build.js'), badBranch);
const scan = scanArchitectureNeutrality({ root });
assert.equal(scan.filesChecked, 2);
assert.equal(scan.architectureLeakCount > 0, true);
assert.equal(scan.violations[0].file.startsWith('js/semantics/'), true);
fs.rmSync(root, { recursive:true, force:true });
console.log('architecture neutrality gate tests passed');
