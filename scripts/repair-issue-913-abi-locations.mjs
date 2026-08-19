import fs from 'node:fs/promises';

async function read(path) { return fs.readFile(path, 'utf8'); }
async function write(path, content) { await fs.writeFile(path, content); }
async function replaceOnce(path, before, after) {
  const source = await read(path);
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`missing ABI-location anchor in ${path}: ${before.slice(0,140)}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`ambiguous ABI-location anchor in ${path}: ${before.slice(0,140)}`);
  await write(path, source.slice(0, first) + after + source.slice(first + before.length));
}

// Preserve ABI parameter indexes and non-GP register classes rather than
// reconstructing argument ordinal from an architecture-specific register list.
await replaceOnce('js/analysis/semantic-function.js',
`    argumentRegisters() {
      let classified = null;
      try { classified = abiPlugin.classifyArguments({}, {}); } catch { classified = null; }
      const registers = (classified?.arguments ?? [])
        .filter((entry) => entry && entry.location === 'register' && typeof entry.reg === 'string' && entry.abiClass !== 'unknown-sse' && entry.abiClass !== 'unknown-float')
        .map((entry) => entry.reg);
      return Object.freeze([...new Set(registers)]);
    },`,
`    argumentLocations({ functionPrototype = null } = {}) {
      let classified = null;
      const instruction = functionPrototype == null ? {} : { callPrototype:functionPrototype };
      const classifyOptions = functionPrototype == null ? {} : { callPrototype:functionPrototype };
      try { classified = abiPlugin.classifyArguments(instruction, classifyOptions); } catch { classified = null; }
      const locations = [];
      const seen = new Set();
      for (const entry of classified?.arguments ?? []) {
        if (!entry || !['register','registers'].includes(entry.location)) continue;
        const registers = Array.isArray(entry.regs) ? entry.regs : typeof entry.reg === 'string' ? [entry.reg] : [];
        for (const register of registers) {
          const reg = String(register || '');
          if (!reg) continue;
          const key = String(entry.index ?? locations.length) + ':' + reg;
          if (seen.has(key)) continue;
          seen.add(key);
          locations.push(Object.freeze({
            index:Number.isInteger(Number(entry.index)) ? Number(entry.index) : locations.length,
            reg,
            abiClass:entry.abiClass ?? null,
          }));
        }
      }
      return Object.freeze(locations);
    },
    argumentRegisters(options = {}) {
      return Object.freeze(this.argumentLocations(options).map((location) => location.reg));
    },`);

await replaceOnce('js/decompiler/pipeline-core.js',
`function abiArgumentRegistersForState(state) {
  try {
    const registers = state.opts?.abiAdapter?.argumentRegisters?.();
    return Array.isArray(registers) ? registers.map(String) : [];
  } catch { return []; }
}

function argumentName(v, state) {
  const groupId = state.highVariables?.valueToGroup?.get(v?.id);
  const group = state.highVariables?.groups?.find((g) => g.id === groupId);
  if (group?.name) return group.name;
  const reg = String(v?.reg || '');
  const index = abiArgumentRegistersForState(state).indexOf(reg);
  if (index < 0) return safeIdent(reg || \`value_\${v?.id}\`);
  if (index === 0 && (state.opts?.receiverType || state.opts?.methodKind === 'objc')) return 'self';
  return state.opts?.argNames?.[index] || \`a\${index + 1}\`;
}`,
`function abiArgumentLocationsForState(state) {
  const functionPrototype = state.opts?.functionPrototype || state.opts?.prototype || state.prototype || null;
  try {
    const locations = state.opts?.abiAdapter?.argumentLocations?.({ functionPrototype });
    if (Array.isArray(locations)) return locations
      .filter((location) => location && typeof location.reg === 'string')
      .map((location, ordinal) => ({
        index:Number.isInteger(Number(location.index)) ? Number(location.index) : ordinal,
        reg:String(location.reg),
        abiClass:location.abiClass ?? null,
      }));
    const registers = state.opts?.abiAdapter?.argumentRegisters?.({ functionPrototype });
    return Array.isArray(registers) ? registers.map((reg, index) => ({ index, reg:String(reg), abiClass:null })) : [];
  } catch { return []; }
}

function abiArgumentLocationForRegister(state, reg) {
  const name = String(reg || '');
  return abiArgumentLocationsForState(state).find((location) => location.reg === name) || null;
}

function argumentName(v, state) {
  const groupId = state.highVariables?.valueToGroup?.get(v?.id);
  const group = state.highVariables?.groups?.find((g) => g.id === groupId);
  if (group?.name) return group.name;
  const reg = String(v?.reg || '');
  const location = abiArgumentLocationForRegister(state, reg);
  if (!location) return safeIdent(reg || \`value_\${v?.id}\`);
  const index = location.index;
  if (index === 0 && (state.opts?.receiverType || state.opts?.methodKind === 'objc')) return 'self';
  return state.opts?.argNames?.[index] || \`a\${index + 1}\`;
}`);

await replaceOnce('js/decompiler/pipeline-core.js',
`  const abiArgumentRegisters = new Set(abiArgumentRegistersForState(state));
  for (const [reg, v] of state.ir.args || []) {
    if (abiArgumentRegisters.has(String(reg)) && (v.uses || []).length) facts.inputs.push({ name: argumentName(v, state), reg, type: typeFor(state, v), valueId: v.id });
  }`,
`  const abiArgumentRegisters = new Set(abiArgumentLocationsForState(state).map((location) => location.reg));
  for (const [reg, v] of state.ir.args || []) {
    if (abiArgumentRegisters.has(String(reg)) && (v.uses || []).length) facts.inputs.push({ name: argumentName(v, state), reg, type: typeFor(state, v), valueId: v.id });
  }`);

const testPath = 'tests/phase6/generic-core/issues-907-909-910-913.test.mjs';
let source = await read(testPath);
source = source.replace(
`import { resolveABIPlugin } from '../../../js/targets/abi/index.js';`,
`import { AAPCS64_ABI, MICROSOFT_X64_ABI, RISCV_LP64D_ABI, UNKNOWN_ABI, resolveABIPlugin } from '../../../js/targets/abi/index.js';`);
const marker = `test('#913 shared decompiler no longer embeds AAPCS64 return/argument register literals', async () => {`;
if (!source.includes("#913 ABI return locations cover FP, void, Microsoft x64, and unknown fail-closed")) {
  const insertion = `test('#913 ABI return locations cover FP, void, Microsoft x64, and unknown fail-closed', () => {\n  const aapcs = semanticAbiAdapter(AAPCS64_ABI);\n  assert.equal(aapcs.returnRegister({ returnType:'double' }), 'v0');\n  assert.equal(aapcs.returnRegister({ returnType:'void' }), null);\n\n  const riscvD = semanticAbiAdapter(RISCV_LP64D_ABI);\n  assert.equal(riscvD.returnRegister({ returnType:'double' }), 'f10');\n\n  const microsoft = semanticAbiAdapter(MICROSOFT_X64_ABI);\n  assert.equal(microsoft.returnRegister({ returnType:'long long' }), 'rax');\n  assert.deepEqual(microsoft.argumentLocations({\n    functionPrototype:{ parameters:[{type:'int64'}, {type:'int64'}] },\n  }).map(({index,reg}) => ({index,reg})), [\n    { index:0, reg:'rcx' },\n    { index:1, reg:'rdx' },\n  ]);\n\n  const unknown = semanticAbiAdapter(UNKNOWN_ABI);\n  assert.equal(unknown.returnRegister({ returnType:'int64' }), null);\n  assert.deepEqual(unknown.argumentLocations(), []);\n});\n\ntest('#913 ABI argument locations preserve cross-class parameter indexes', () => {\n  const aapcs = semanticAbiAdapter(AAPCS64_ABI);\n  assert.deepEqual(aapcs.argumentLocations({\n    functionPrototype:{ parameters:[{type:'int64'}, {type:'double'}] },\n  }).map(({index,reg}) => ({index,reg})), [\n    { index:0, reg:'x0' },\n    { index:1, reg:'v0' },\n  ]);\n\n  const riscvD = semanticAbiAdapter(RISCV_LP64D_ABI);\n  assert.deepEqual(riscvD.argumentLocations({\n    functionPrototype:{ parameters:[{type:'int64'}, {type:'double'}] },\n  }).map(({index,reg}) => ({index,reg})), [\n    { index:0, reg:'x10' },\n    { index:1, reg:'f10' },\n  ]);\n});\n\n`;
  source = source.replace(marker, insertion + marker);
}
source = source.replace(
`  assert.match(source, /abiAdapter\\?\\.argumentRegisters/);`,
`  assert.match(source, /abiAdapter\\?\\.argumentLocations/);\n  assert.doesNotMatch(source, /\\^x\\[0-7\\]\\$/);`);
await write(testPath, source);

console.log('issue #913 ABI location/index contract and acceptance coverage staged');
