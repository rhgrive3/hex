import { deriveCanonicalAddressProof, canonicalAddressProofToRegionEvidence } from '../../js/analysis/alias/canonical-address-v2-core.js';
import { aliasMemoryRegions } from '../../js/analysis/alias/legacy-safety-floor.js';
function ok(v,m){ if(!v) throw new Error(m||'expected truthy'); }
function eq(a,e,m){ if(a!==e) throw new Error(`${m||'not equal'}: got ${String(a)}, want ${String(e)}`); }
function proofFor(canonicalRoot,widthBits=64){ return deriveCanonicalAddressProof({functionId:'issue817',values:[{id:'v',kind:'computed',machineType:{widthBits},definitionNodeId:'n',metadata:{canonicalRoot}}],nodes:[{id:'n',kind:'copy',inputs:[]}],blocks:[]},'v'); }
for (const widthBits of [32,64]) {
  const proof=proofFor({kind:'stack-like',baseOffset:-4,linearOffsets:true,addressSpace:'memory'},widthBits);
  eq(proof.offset,-4n,`#817 ${widthBits}-bit stack proof stays signed`);
  eq(canonicalAddressProofToRegionEvidence(proof).offset,'-4',`#817 ${widthBits}-bit region evidence stays signed`);
}
{ const proof=proofFor({kind:'rooted-object',rootEntityId:'entity_issue817',rootIdentity:{kind:'fixture-root',id:'root'},baseOffset:-8,linearOffsets:true,addressSpace:'memory'}); eq(proof.offset,-8n,'#817 rooted offset stays signed'); ok(proof.separationSafe===true,'#817 separation retained'); }
eq(aliasMemoryRegions({kind:'stack-fixed',functionId:'issue817',offset:'-4',widthBits:64},{kind:'stack-fixed',functionId:'issue817',offset:'0',widthBits:32}),'may','#817 overlap across zero');
eq(aliasMemoryRegions({kind:'stack-fixed',functionId:'issue817',offset:'-16',widthBits:64},{kind:'stack-fixed',functionId:'issue817',offset:'0',widthBits:64}),'no','#817 signed disjoint intervals');
eq(aliasMemoryRegions({kind:'stack-fixed',functionId:'issue817',offset:'-8',widthBits:64},{kind:'stack-fixed',functionId:'issue817',offset:'-4',widthBits:64}),'may','#817 negative overlap');
console.log('issue-817-canonical-stack-offsets: PASS');
