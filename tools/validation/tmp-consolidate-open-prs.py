from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def replace_once(path, old, new, label):
    p = ROOT / path
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match in {path}, got {count}")
    p.write_text(text.replace(old, new, 1))


def git_show(commit, path):
    data = subprocess.check_output(["git", "show", f"{commit}:{path}"], cwd=ROOT)
    (ROOT / path).write_bytes(data)


# #857 — preserve the 32-bit comparison domain through current Phase-6 SSA/v1 projection.
p = ROOT / "js/ir.js"
s = p.read_text()
old = """  const rhs = shiftedConst(cmp.args[1], cmp.args[0].value.bits || 64);\n  if (rhs == null) return null;\n  return { lhs: cmp.args[0].value, rhs, cond: branch.cond || null, cmp };"""
new = """  const bits = Number(cmp.extra?.widthBits || cmp.extra?.bits || cmp.args[0].bits || cmp.args[1].bits || cmp.args[0].value.bits || 64);\n  const rhs = shiftedConst(cmp.args[1], bits);\n  if (rhs == null) return null;\n  return { lhs: cmp.args[0].value, rhs, bits, cond: branch.cond || null, cmp };"""
if s.count(old) != 1: raise SystemExit("#857 comparisonOfBranch source drifted")
s = s.replace(old, new, 1)
old = """function constrainedRange(value, op, constant, signed) {\n  const bits = value && value.bits || 64;\n  const rhs = normalizeIntegerValue(constant, bits, signed);\n  const bounds = typeBounds(bits, signed);"""
new = """function constrainedRange(value, op, constant, signed, bitsOverride = null) {\n  const bits = Number(bitsOverride || (value && value.bits) || 64);\n  const rhs = normalizeIntegerValue(constant, bits, signed);\n  const bounds = typeBounds(bits, signed);"""
if s.count(old) != 1: raise SystemExit("#857 constrainedRange source drifted")
s = s.replace(old, new, 1)
old = """  const existing = valueRange(value);\n  if (existing) { if (existing.min > min) min = existing.min; if (existing.max < max) max = existing.max; }"""
new = """  const existing = normalizeRangeDomain(valueRange(value), bits, signed);\n  if (existing) { if (existing.min > min) min = existing.min; if (existing.max < max) max = existing.max; }"""
if s.count(old) != 1: raise SystemExit("#857 range-domain source drifted")
s = s.replace(old, new, 1)
old = """  const rhs = normalizeIntegerValue(c.rhs, c.lhs.bits || 64, signedForBounds);\n  const range = constrainedRange(c.lhs, relation, rhs, signedForBounds);"""
new = """  const bits = Number(c.bits || c.lhs.bits || 64);\n  const rhs = normalizeIntegerValue(c.rhs, bits, signedForBounds);\n  const range = constrainedRange(c.lhs, relation, rhs, signedForBounds, bits);"""
if s.count(old) != 1: raise SystemExit("#857 rangeOnBranch source drifted")
p.write_text(s.replace(old, new, 1))

p = ROOT / "js/semantics/compat/semantic-ir-v2-to-v1.js"
s = p.read_text()
old = """function addComparisonCarriers(ir, values, valuesById) {\n  const flagWriteInstructionIds = new Set();\n  for (const node of ir.nodes) {\n    if (node.kind !== 'state-write' || node.variable?.physicalIdentity?.kind !== 'flag') continue;\n    for (const id of sourceInstructionIds(node.origin)) flagWriteInstructionIds.add(id);\n  }\n\n  const byNodeId = new Map();\n  for (const node of ir.nodes) {"""
new = """function addComparisonCarriers(ir, values, valuesById) {\n  const flagWriteInstructionIds = new Set();\n  const addWithCarryInstructionIds = new Set();\n  for (const node of ir.nodes) {\n    if (node.kind === 'state-write' && node.variable?.physicalIdentity?.kind === 'flag') {\n      for (const id of sourceInstructionIds(node.origin)) flagWriteInstructionIds.add(id);\n    }\n    if (node.kind === 'intrinsic' && node.operator === 'add-with-carry') {\n      for (const id of sourceInstructionIds(node.origin)) addWithCarryInstructionIds.add(id);\n    }\n  }\n\n  const byNodeId = new Map();\n  for (const node of ir.nodes) {"""
if s.count(old) != 1: raise SystemExit("#857 comparison-carrier prelude drifted")
s = s.replace(old, new, 1)
old = """    const flagProducingArithmetic = sameInstruction(node, flagWriteInstructionIds)\n      && ((node.kind === 'intrinsic' && node.operator === 'add-with-carry') || node.kind === 'binary');"""
new = """    // Auxiliary binary nodes may construct an operand for the same machine\n    // instruction. Canonical add-with-carry remains the flag-producing authority.\n    const canonicalAddWithCarry = node.kind === 'intrinsic' && node.operator === 'add-with-carry';\n    const auxiliaryBinary = node.kind === 'binary' && sameInstruction(node, addWithCarryInstructionIds);\n    const flagProducingArithmetic = sameInstruction(node, flagWriteInstructionIds)\n      && (canonicalAddWithCarry || (node.kind === 'binary' && !auxiliaryBinary));"""
if s.count(old) != 1: raise SystemExit("#857 comparison-carrier predicate drifted")
p.write_text(s.replace(old, new, 1))

# #881 — current-main guarded correctness fixes.
replace_once(
    "js/emu.js",
    "    if (mn === 'neg' || mn === 'negs') { this.set(ops[0].text, -R(ops[1])); return null; }",
    """    if (mn === 'neg' || mn === 'negs') {\n      const wide = isWide(ops[0]);\n      const operand = R(ops[1]);\n      const result = BigInt.asUintN(wide ? 64 : 32, -operand);\n      this.set(ops[0].text, result);\n      if (mn === 'negs') this.setFlags('subs', 0n, operand, result, wide);\n      return null;\n    }""",
    "#802 NEGS",
)
replace_once(
    "js/emu.js",
    "        else if (o === 'asr') v = BigInt.asIntN(64, v) >> s;",
    "        else if (o === 'asr') v = BigInt.asIntN(op.bits === 32 ? 32 : 64, v) >> s;",
    "#821 W ASR",
)
replace_once(
    "js/expr.js",
    "      const shifted = bin('shr', A(), constNode(lsb), bits);\n      emit(dst, width > 0n && width < 64n ? bin('and', shifted, constNode((1n << width) - 1n), bits) : shifted);",
    """      const destWidth = BigInt(bits);\n      if (lsb < 0n || width <= 0n || lsb + width > destWidth) {\n        regs.delete(dst);\n      } else {\n        const shifted = bin('shr', A(), constNode(lsb), bits);\n        const field = width < destWidth ? bin('and', shifted, constNode((1n << width) - 1n), bits) : shifted;\n        if (base === 'sbfx' && width < destWidth) {\n          const signBit = 1n << (width - 1n);\n          emit(dst, bin('sub', bin('xor', field, constNode(signBit), bits), constNode(signBit), bits));\n        } else emit(dst, field);\n      }""",
    "#824 SBFX",
)
replace_once(
    "js/ir.js",
    """function sizeCompatible(a, b) {\n  if (a.size == null || b.size == null) return true;\n  return a.size === b.size;\n}""",
    """function sizeCompatible(a, b) {\n  if (a.size == null || b.size == null) return false;\n  return a.size === b.size;\n}""",
    "#859 MustAlias unknown extent",
)
replace_once(
    "js/ir.js",
    "    const sa = BigInt(x.size || 8), sb = BigInt(y.size || 8);\n    return !(pa + sa <= pb || pb + sb <= pa);",
    "    if (x.size == null || y.size == null) return true;\n    const sa = BigInt(x.size), sb = BigInt(y.size);\n    return !(pa + sa <= pb || pb + sb <= pa);",
    "#859 GLOBAL MayAlias",
)
replace_once(
    "js/ir.js",
    "    const sa = BigInt(x.size || 8), sb = BigInt(y.size || 8);\n    return !(x.disp + sa <= y.disp || y.disp + sb <= x.disp);",
    "    if (x.size == null || y.size == null) return true;\n    const sa = BigInt(x.size), sb = BigInt(y.size);\n    return !(x.disp + sa <= y.disp || y.disp + sb <= x.disp);",
    "#859 STACK MayAlias",
)
replace_once(
    "js/semantics/ir/normalize-effects.js",
    "  'add', 'sub', 'mul', 'sdiv', 'udiv', 'div', 'and', 'or', 'orr', 'xor', 'eor', 'bic', 'orn', 'eon',",
    "  'add', 'sub', 'mul', 'sdiv', 'udiv', 'div', 'srem', 'urem', 'and', 'or', 'orr', 'xor', 'eor', 'bic', 'orn', 'eon',",
    "#866 remainder normalization",
)

issue_test = r'''import assert from 'node:assert/strict';
import { Emulator } from '../js/emu.js';
import { buildValues } from '../js/expr.js';
import { MK, mustAlias, mayAliasProvenance } from '../js/ir.js';
import { classifyMachineValueOpcode } from '../js/semantics/ir/normalize-effects.js';
function gp(text,bits=text.startsWith('w')?32:64){const m=/^(?:x|w)(\d+)$/.exec(text);return{k:'reg',text,cls:'gp',bits,num:m?Number(m[1]):0};}
function imm(value){return{k:'imm',value:BigInt(value)};}
{
 const e=new Emulator({}); e.set('w1',1n); e.nzcv={n:false,z:true,c:true,v:true}; await e.execute('negs','w0, w1',0n); assert.equal(e.get('w0'),0xffffffffn); assert.deepEqual(e.nzcv,{n:true,z:false,c:false,v:false});
 e.set('w1',0n); await e.execute('negs','w0, w1',0n); assert.deepEqual(e.nzcv,{n:false,z:true,c:true,v:false});
 e.set('w1',0x80000000n); await e.execute('negs','w0, w1',0n); assert.deepEqual(e.nzcv,{n:true,z:false,c:false,v:true});
 e.nzcv={n:false,z:false,c:true,v:true}; await e.execute('neg','w0, w1',0n); assert.deepEqual(e.nzcv,{n:false,z:false,c:true,v:true});
}
{
 const e=new Emulator({}); e.set('w1',0n); e.set('w2',0x80000000n); await e.execute('add','w0, w1, w2, asr #1',0n); assert.equal(e.get('w0'),0xc0000000n);
 e.set('w2',0x40000000n); await e.execute('orr','w0, wzr, w2, asr #1',0n); assert.equal(e.get('w0'),0x20000000n);
 e.set('x1',0n); e.set('x2',0x8000000000000000n); await e.execute('add','x0, x1, x2, asr #1',0n); assert.equal(e.get('x0'),0xc000000000000000n);
}
function evalExpr(n){if(!n)throw new Error('missing expression');if(n.k==='const')return n.v;if(n.k==='un'){const a=evalExpr(n.a);if(n.op==='uxt32')return BigInt.asUintN(32,a);if(n.op==='sxt32')return BigInt.asIntN(32,a);if(n.op==='neg')return-a;throw new Error('unsupported unary '+n.op);}if(n.k==='bin'){const a=evalExpr(n.a),b=evalExpr(n.b);if(n.op==='shr')return BigInt.asUintN(64,a)>>b;if(n.op==='and')return a&b;if(n.op==='xor')return a^b;if(n.op==='sub')return a-b;throw new Error('unsupported binary '+n.op);}throw new Error('unsupported node '+n.k);}
function inst(row,mnemonic,ops,reads,writes){return{row,address:BigInt(row*4),mnemonic,ops,reads,writes,data:false,isCall:false,isReturn:false};}
function sbfxResult(dst,srcValue,lsb,width){const bits=dst.startsWith('w')?32:64,src=bits===32?'w1':'x1';const model={instructions:[inst(0,'mov',[gp(src,bits),imm(srcValue)],[],['x1']),inst(1,'sbfx',[gp(dst,bits),gp(src,bits),imm(lsb),imm(width)],['x1'],['x0'])],basicBlocks:[],calls:[],addressRefs:[]};return buildValues(model).defAt(1,'x0');}
assert.equal(evalExpr(sbfxResult('x0',0x80n,0n,8n)),-128n); assert.equal(evalExpr(sbfxResult('x0',0x7fn,0n,8n)),127n); assert.equal(evalExpr(sbfxResult('x0',0x8000n,8n,8n)),-128n); assert.equal(evalExpr(sbfxResult('w0',0x80n,0n,8n)),0xffffff80n);
assert.equal(mustAlias({kind:MK.GLOBAL,address:0x1000n,size:null},{kind:MK.GLOBAL,address:0x1000n,size:4}),false);
assert.equal(mustAlias({kind:MK.STACK,disp:0n,size:null},{kind:MK.STACK,disp:0n,size:4}),false);
assert.equal(mayAliasProvenance({kind:MK.GLOBAL,address:0x1000n,size:null},{kind:MK.GLOBAL,address:0x1008n,size:8}),true);
assert.equal(mayAliasProvenance({kind:MK.STACK,disp:0n,size:null},{kind:MK.STACK,disp:8n,size:8}),true);
assert.equal(mayAliasProvenance({kind:MK.GLOBAL,address:0x1000n,size:8},{kind:MK.GLOBAL,address:0x1008n,size:8}),false);
assert.equal(mustAlias({kind:MK.GLOBAL,address:0x1000n,size:8},{kind:MK.GLOBAL,address:0x1000n,size:8}),true);
assert.deepEqual(classifyMachineValueOpcode('srem'),{kind:'binary',operator:'srem'}); assert.deepEqual(classifyMachineValueOpcode('urem'),{kind:'binary',operator:'urem'});
console.log('issues 802/821/824/859/866: ok');
'''
(ROOT / "tests/issues-802-821-824-859-866.mjs").write_text(issue_test)
replace_once(
    "package.json",
    '"test": "node tests/phase4/integration/backend-open-race-current-oracle.test.mjs',
    '"test": "node tests/issues-802-821-824-859-866.mjs && node tests/phase4/integration/backend-open-race-current-oracle.test.mjs',
    "#881 package test registration",
)

# #878 exact reviewed RISC-V ABI source/test blobs.
git_show("9f2a4ab2b4480552498e26299326e048581a5360", "js/targets/abi/riscv-lp64.js")
git_show("9f2a4ab2b4480552498e26299326e048581a5360", "tests/phase6/abi/riscv-issues-868-872.test.mjs")

# #879 exact reviewed Supervisor-resume source/test blobs.
git_show("8d5d3998b019662e159516dd56f4ad7a254a3b6b", "js/userscript/dev/parent-worker-runtime.js")
git_show("8d5d3998b019662e159516dd56f4ad7a254a3b6b", "tests/dev-agent/pool-completion-event-resume.mjs")
git_show("8d5d3998b019662e159516dd56f4ad7a254a3b6b", "tests/userscript-runtime-host-location.mjs")

# Mixed integration validator: it delegates only the Phase-4-owned subset to
# the existing p4-7 manifest; all other phase files remain governed by their own gates.
helper = r'''import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
function arg(name, fallback = null) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; }
function phase4Path(file) {
  const prefixes = ['js/core/artifacts/','js/core/scheduler/','js/core/budgets/','js/project/','js/cache/','tests/phase4/','tools/validation/phase4/','reports/phase4/'];
  if (prefixes.some((prefix) => file.startsWith(prefix))) return true;
  if (['js/bytesource/cached.js','js/backend.js','tools/validation/phase4-ownership.mjs','tools/validation/phase-ownership/phase4.json','package.json'].includes(file)) return true;
  if (/^js\/worker[^/]*\.js$/.test(file)) return true;
  return /^\.github\/workflows\/phase4-[^/]*\.yml$/.test(file);
}
let changed;
const filesArg = arg('files');
if (filesArg != null) changed = filesArg.split(',').map((item) => item.trim()).filter(Boolean);
else if (process.argv.includes('--files0-stdin')) changed = fs.readFileSync(0).toString('utf8').split('\0').filter(Boolean);
else {
  const base = arg('base-sha'), head = arg('head-sha');
  if (!base || !head) { console.error('phase4 mixed integration: missing exact inventory input'); process.exit(2); }
  changed = execFileSync('git', ['diff','--name-only','-z',`${base}...${head}`], { cwd:ROOT }).toString('utf8').split('\0').filter(Boolean);
}
const phase4Changed = changed.filter(phase4Path);
for (const file of phase4Changed) {
  if (/[\r\n,]/.test(file)) { console.error(`phase4 mixed integration: unsupported path: ${JSON.stringify(file)}`); process.exit(2); }
  const child = spawnSync(process.execPath, ['tools/validation/phase4-ownership.mjs','--lane','p4-7','--files',file], { cwd:ROOT, encoding:'utf8' });
  if (child.status !== 0) { process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || ''); console.error(`phase4 mixed integration: rejected ${file}`); process.exit(child.status || 1); }
}
console.log(JSON.stringify({phase:4,mode:'mixed-integration',totalChangedFiles:changed.length,phase4ChangedFiles:phase4Changed.length,violations:0}));
'''
(ROOT / "tools/validation/phase4/mixed-integration.mjs").write_text(helper)

mixed_test = r'''import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
function run(files){return spawnSync(process.execPath,['tools/validation/phase4/mixed-integration.mjs','--files',files.join(',')],{encoding:'utf8'});}
const mixed=run(['js/worker-legacy.js','js/ir.js']); assert.equal(mixed.status,0,mixed.stderr); const report=JSON.parse(mixed.stdout.trim().split(/\r?\n/).at(-1)); assert.equal(report.phase4ChangedFiles,1);
const forbidden=run(['tools/validation/phase-ownership/phase4.json']); assert.notEqual(forbidden.status,0);
console.log('phase4 mixed-integration ownership routing: PASS');
'''
(ROOT / "tests/phase4/ownership/mixed-integration.test.mjs").write_text(mixed_test)

# Route the consolidation branch through explicit mixed ownership.
p = ROOT / ".github/workflows/phase4-ownership.yml"
s = p.read_text()
old = "            hex/p6-riscv64-integration) phase=6; lane=p6 ;;\n            *)"
new = "            hex/p6-riscv64-integration) phase=6; lane=p6 ;;\n            integrate/open-issue-fixes-*) phase=mixed; lane=p4-7 ;;\n            *)"
if s.count(old) != 1: raise SystemExit("Phase4 ownership route drifted")
s = s.replace(old, new, 1).rstrip()
gh_base = '$' + '{{ github.event.pull_request.base.sha }}'
gh_head = '$' + '{{ github.event.pull_request.head.sha }}'
s += f'''\n      - name: Enforce exact Phase 4 subset for mixed issue integration
        if: steps.lane.outputs.phase == 'mixed'
        run: >-
          node tools/validation/phase4/mixed-integration.mjs
          --base-sha "{gh_base}"
          --head-sha "{gh_head}"
'''
p.write_text(s)

p = ROOT / ".github/workflows/phase4-release-validation.yml"
s = p.read_text()
old = "            hex/p6-riscv64-integration) mode=phase6; lane=p6 ;;\n            *) mode=phase4; lane=p4-7 ;;"
new = "            hex/p6-riscv64-integration) mode=phase6; lane=p6 ;;\n            integrate/open-issue-fixes-*) mode=mixed; lane=p4-7 ;;\n            *) mode=phase4; lane=p4-7 ;;"
if s.count(old) != 1: raise SystemExit("Phase4 exact-SHA route drifted")
s = s.replace(old, new, 1)
anchor = "      - name: Upload independent verifier evidence\n        if: always()\n"
if s.count(anchor) != 1: raise SystemExit("Phase4 exact-SHA evidence anchor drifted")
mixed_step = f'''      - name: Independent Phase 4 verifier for mixed issue integration — blocking release gate
        if: steps.ownership.outputs.mode == 'mixed'
        shell: bash
        env:
          OWNERSHIP_BASE_SHA: {gh_base}
        run: |
          set -euo pipefail
          npm run phase4:verify -- \\
            --base "$PHASE4_BASE" \\
            --head "$PRODUCT_SHA" \\
            --ownership-base "$PRODUCT_SHA" \\
            --lane p4-7
          node tools/validation/phase4/mixed-integration.mjs \\
            --base-sha "$OWNERSHIP_BASE_SHA" \\
            --head-sha "$PRODUCT_SHA"
'''
p.write_text(s.replace(anchor, mixed_step + anchor, 1))

print("consolidation source materialized")
