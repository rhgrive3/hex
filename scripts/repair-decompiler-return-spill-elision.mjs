import fs from 'node:fs/promises';

const path = 'js/decompiler/pipeline-core.js';
let source = await fs.readFile(path, 'utf8');
function replaceOnce(before, after) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`missing return-spill anchor: ${before.slice(0,160)}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`ambiguous return-spill anchor: ${before.slice(0,160)}`);
  source = source.slice(0, first) + after + source.slice(first + before.length);
}

replaceOnce(
`function knownStatementForLine(line, state) {`,
`function valueDependsOnAny(value, targetValueIds, active = new Set()) {
  if (!value || active.has(value.id)) return false;
  if (targetValueIds.has(value.id)) return true;
  active.add(value.id);
  const def = value.def;
  if (!def) { active.delete(value.id); return false; }
  const inputs = [
    ...(def.args || []).map((arg) => arg?.value).filter(Boolean),
    ...(def.incoming || []).map((item) => item?.value).filter(Boolean),
  ];
  const result = inputs.some((input) => valueDependsOnAny(input, targetValueIds, active));
  active.delete(value.id);
  return result;
}

/*
 * Hide only a stack slot proven to be machine-level return preservation across
 * a call. MemorySSA must identify one exact store and one exact reaching load;
 * that load must feed the function return, and no call argument may depend on
 * the spill address base. This keeps ordinary locals/address-taken slots
 * visible while avoiding an invalid duplicate \`var_* = expr; return expr;\`.
 */
function isElidableReturnSpillStore(store, state) {
  if (!store || store.op !== OP.STORE || store.loc?.kind !== MK.STACK || !store.loc?.key) return false;
  const instructions = state.ir?.instructions || [];
  const sameLocationMemory = instructions.filter((inst) =>
    (inst.op === OP.LOAD || inst.op === OP.STORE) && inst.loc?.key === store.loc.key);
  const loads = sameLocationMemory.filter((inst) => inst.op === OP.LOAD && inst.reachingStore === store);
  if (loads.length !== 1 || sameLocationMemory.some((inst) => inst.op === OP.STORE && inst !== store)) return false;
  const load = loads[0];
  if (store.row == null || load.row == null || Number(load.row) <= Number(store.row) || !load.dst) return false;

  const calls = instructions.filter((inst) => inst.op === OP.CALL && inst.row != null
    && Number(inst.row) > Number(store.row) && Number(inst.row) < Number(load.row));
  if (!calls.length) return false;

  const addressBaseId = store.addr?.base?.id ?? null;
  if (addressBaseId != null) {
    const addressBase = new Set([addressBaseId]);
    if (calls.some((call) => (call.args || []).some((arg) => valueDependsOnAny(arg?.value, addressBase)))) return false;
  }

  const loadIds = new Set([load.dst.id]);
  const storedValue = valueOf(store.args?.[0]);
  if (!storedValue) return false;
  const storedKey = structuralKey(expressionFor(storedValue, state));
  if (!storedKey) return false;

  for (const ret of instructions) {
    if (ret.op !== OP.RET || ret.row == null || Number(ret.row) <= Number(load.row)) continue;
    const returned = returnValueAt(ret, state);
    if (!returned || !valueDependsOnAny(returned, loadIds)) continue;
    if (structuralKey(expressionFor(returned, state)) === storedKey) return true;
  }
  return false;
}

function knownStatementForLine(line, state) {`);

replaceOnce(
`  const store = insts.find((i) => i.op === OP.STORE);
  if (store) {
    if (insts.some((i) => i.op === OP.CALL && i.row === store.row)) return null;
    const location = memoryLocation(store, state), value = valueOf(store.args?.[0]);`,
`  const store = insts.find((i) => i.op === OP.STORE);
  if (store) {
    if (insts.some((i) => i.op === OP.CALL && i.row === store.row)) return null;
    if (isElidableReturnSpillStore(store, state)) {
      return {
        text:'',
        semantic:{ op:'elided-return-spill', ir:store.id },
        source:sourceOf({ ir:store.id, value:valueOf(store.args?.[0]), reason:'memoryssa-return-spill' }),
      };
    }
    const location = memoryLocation(store, state), value = valueOf(store.args?.[0]);`);

await fs.writeFile(path, source);
console.log('proven stack-only return spill elision staged');
