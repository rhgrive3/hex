#!/usr/bin/env bash
set -euo pipefail

git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git fetch origin integrate/all-open-prs-20260819 fix/unlinked-abi-526-954-955-958-959

set +e
git merge --no-commit --no-ff origin/fix/unlinked-abi-526-954-955-958-959
set -e

# Generated files/workflow are owned by the current integration branch.
git checkout --ours -- .github/workflows/generated-sync.yml userscript/hex.user.template.js userscript/release-version.json
git add .github/workflows/generated-sync.yml userscript/hex.user.template.js userscript/release-version.json

# Preserve the current Microsoft-x64 conflict side; non-conflicting #987 hunks stay applied.
python - <<'PY'
from pathlib import Path
import re
p=Path('js/targets/abi/microsoft-x64.js')
s=p.read_text()
pat=re.compile(r'^<<<<<<< HEAD\n(.*?)^=======\n.*?^>>>>>>> .*?\n',re.M|re.S)
s,n=pat.subn(lambda m:m.group(1),s)
if n != 1 or '<<<<<<<' in s or '>>>>>>>' in s:
    raise SystemExit(f'microsoft-x64 conflict resolution count={n}')
p.write_text(s)
PY
git add js/targets/abi/microsoft-x64.js

# Current AAPCS64 aggregate/128-bit rules are authoritative. Layer only the
# conservative unknown/variadic input contract and Darwin split from #987.
git checkout --ours -- js/targets/abi/aapcs64.js
python - <<'PY'
from pathlib import Path
p=Path('js/targets/abi/aapcs64.js')
s=p.read_text()
def once(old,new,label):
    global s
    n=s.count(old)
    if n != 1: raise SystemExit(f'{label}: expected 1 match, got {n}')
    s=s.replace(old,new,1)
once("export function classifyAAPCS64Arguments(insn, opts = {}) {", """function possibleRegisterSource(reg, bits, abiClass) {
  return { t:'reg', reg, bits, possible:true, mustUse:false, purpose:'variadic-tail-candidate', abiClass };
}

export function classifyAAPCS64Arguments(insn, opts = {}) {""", 'helper')
once("""  if (!params) {
    for (let i=0;i<8;i++) { srcs.push({t:'reg',reg:`x${i}`,bits:64}); arguments_.push({index:i,location:'register',reg:`x${i}`,abiClass:'unknown-gp'}); }
    for (let i=0;i<8;i++) { srcs.push({t:'reg',reg:`v${i}`,bits:128}); arguments_.push({index:8+i,location:'register',reg:`v${i}`,abiClass:'unknown-fp-vector'}); }
    return { srcs, arguments:arguments_, stackArguments, stackArgsUnknown:true, stackArgsMayContainPointers:false, evidence:'conservative-aapcs64' };
  }""", """  if (!params) {
    for (let i=0;i<8;i++) {
      srcs.push({t:'reg',reg:`x${i}`,bits:64,possible:true,mustUse:false,abiClass:'unknown-gp'});
      arguments_.push({index:i,location:'register',reg:`x${i}`,abiClass:'unknown-gp',possible:true,mustUse:false,mayContainPointers:true});
    }
    for (let i=0;i<8;i++) {
      srcs.push({t:'reg',reg:`v${i}`,bits:128,possible:true,mustUse:false,abiClass:'unknown-fp-vector'});
      arguments_.push({index:8+i,location:'register',reg:`v${i}`,abiClass:'unknown-fp-vector',possible:true,mustUse:false});
    }
    return { srcs, arguments:arguments_, stackArguments, stackArgsUnknown:true, stackArgsMayContainPointers:true, possibleRegisterInputs:srcs.slice(), partial:true, evidence:'conservative-aapcs64' };
  }""", 'unknown')
once("for(let n=0;n<regsNeeded;n++){const reg=`v${fp++}`;regs.push(reg);srcs.push({t:'reg',reg,bits:c.vector?128:c.bits});}", "for(let n=0;n<regsNeeded;n++){const reg=`v${fp++}`;regs.push(reg);srcs.push({t:'reg',reg,bits:c.vector?128:c.bits,possible:false,mustUse:true});}", 'fp-src')
once("arguments_.push({index,location:'register',regs,reg:regs[0],abiClass:c.hfa?'hfa':c.vector?'vector':'fp',pointer:c.pointer,bits:c.bits});", "arguments_.push({index,location:'register',regs,reg:regs[0],abiClass:c.hfa?'hfa':c.vector?'vector':'fp',pointer:c.pointer,bits:c.bits,possible:false,mustUse:true});", 'fp-arg')
once("const reg=`x${gp++}`; srcs.push({t:'reg',reg,bits:64});", "const reg=`x${gp++}`; srcs.push({t:'reg',reg,bits:64,possible:false,mustUse:true});", 'gp-src')
once("arguments_.push({index,location:'register',reg,abiClass:c.pointer?'pointer':'integer',pointer:c.pointer,bits:c.bits});", "arguments_.push({index,location:'register',reg,abiClass:c.pointer?'pointer':'integer',pointer:c.pointer,bits:c.bits,possible:false,mustUse:true});", 'gp-arg')
once("const entry={index,location:'stack',offset:stackOffset,bytes:slots*8,abiClass:c.hfa?'hfa':c.vector?'vector':c.fp?'fp':c.pointer?'pointer':'integer',pointer:c.pointer,bits:c.bits};", "const entry={index,location:'stack',offset:stackOffset,bytes:slots*8,abiClass:c.hfa?'hfa':c.vector?'vector':c.fp?'fp':c.pointer?'pointer':'integer',pointer:c.pointer,bits:c.bits,possible:false,mustUse:true};", 'stack')
once("""  return {
    srcs, arguments:arguments_, stackArguments,
    stackArgsUnknown:proto?.variadic===true||proto?.varargs===true,
    stackArgsMayContainPointers,
    evidence:unsupported.length?'partial-aapcs64-unsupported-sve':'prototype-aapcs64',
    unsupported:unsupported.length>0,
    unsupportedArguments:unsupported,
  };
}""", """  const variadic=proto?.variadic===true||proto?.varargs===true;
  const possibleRegisterInputs=[];
  if (variadic) {
    for (let i=gp;i<8;i++) { const source=possibleRegisterSource(`x${i}`,64,'variadic-unknown-gp'); srcs.push(source); possibleRegisterInputs.push(source); arguments_.push({index:null,location:'register',reg:`x${i}`,bits:64,abiClass:'variadic-unknown-gp',possible:true,mustUse:false,mayContainPointers:true}); }
    for (let i=fp;i<8;i++) { const source=possibleRegisterSource(`v${i}`,128,'variadic-unknown-fp-vector'); srcs.push(source); possibleRegisterInputs.push(source); arguments_.push({index:null,location:'register',reg:`v${i}`,bits:128,abiClass:'variadic-unknown-fp-vector',possible:true,mustUse:false}); }
  }
  return {
    srcs, arguments:arguments_, stackArguments,
    stackArgsUnknown:variadic,
    stackArgsMayContainPointers:stackArgsMayContainPointers||variadic,
    possibleRegisterInputs,
    partial:variadic||unsupported.length>0,
    evidence:unsupported.length?'partial-aapcs64-unsupported-sve':variadic?'prototype-aapcs64-variadic':'prototype-aapcs64',
    unsupported:unsupported.length>0,
    unsupportedArguments:unsupported,
  };
}""", 'variadic')
once("platformPredicate:({ platform }) => !platform || platform === 'darwin' || platform === 'apple' || platform === 'macos' || platform === 'ios' || platform === 'ipados' || platform === 'linux' || platform === 'android' || platform === 'unknown',", "platformPredicate:({ platform }) => !platform || platform === 'linux' || platform === 'android' || platform === 'unknown',", 'darwin')
once("stackRules:()=>Object.freeze({ alignment:16, stackGrows:'down', argumentSlotBytes:8 }),", "stackRules:()=>Object.freeze({ alignment:16, stackGrows:'down', argumentSlotBytes:8, variadicRegisterSaveAreas:true }),", 'stackRules')
once("defaultUnknownCallEffects:(context)=>Object.freeze({ registerClobbers:callerSavedFor(context), memoryEffects:'unknown', mayThrow:true }),", "defaultUnknownCallEffects:(context)=>Object.freeze({ registerClobbers:callerSavedFor(context), memoryEffects:'unknown', mayThrow:true, stackArguments:'unknown', stackArgsMayContainPointers:true }),", 'unknownEffects')
p.write_text(s)
PY
git add js/targets/abi/aapcs64.js

# Keep current test command ordering, add the reconciled ABI regression once.
git checkout --ours -- package.json
python - <<'PY'
from pathlib import Path
p=Path('package.json'); s=p.read_text(); add='node tests/issues-526-954-955-958-959.mjs && '
if add not in s:
    anchor='node tests/issues-521-527.mjs && '
    if s.count(anchor)!=1: raise SystemExit('package anchor missing')
    s=s.replace(anchor,anchor+add,1)
p.write_text(s)
PY
git add package.json

if git diff --name-only --diff-filter=U | grep -q .; then
  git diff --name-only --diff-filter=U
  exit 1
fi

npm ci
node tests/issues-526-954-955-958-959.mjs
node tests/architecture-abi.mjs
node tests/issues-961-971.mjs
npm run phase5:test
npm run lint
npm run userscript:build
npm run check

# Restore canonical integration workflow and remove all reconciliation scaffolding.
git show origin/integrate/all-open-prs-20260819:.github/workflows/generated-sync.yml > .github/workflows/generated-sync.yml
rm -f .github/workflows/tmp-pr987-userscript-build.yml \
      .github/workflows/tmp-abi-reconcile.yml \
      .github/workflows/tmp-abi-reconcile-push.yml \
      .github/abi-reconcile-trigger \
      js/.abi-reconcile-trigger \
      .github/reconcile-pr998.sh

git add -A
git diff --cached --check
git commit -m 'fix: reconcile ABI correctness issues #526 #954 #955 #958 #959'
git push origin HEAD:fix/integration-abi-526-954-955-958-959
