import test from 'node:test';
import assert from 'node:assert/strict';
import { liftArm64AtomicEffects } from '../../js/targets/architecture/arm64/effects/atomic.js';
import { liftArm64SystemEffects } from '../../js/targets/architecture/arm64/effects/system.js';
const gp=(n,bits=64)=>({k:'reg',cls:'gp',num:n,bits,text:`${bits===32?'w':'x'}${n}`});
const mem=(n)=>({k:'mem',base:gp(n),disp:0n,mode:'offset',text:`[x${n}]`});
const ids=['arm64.exclusive.valid','arm64.exclusive.address','arm64.exclusive.size','arm64.exclusive.token'];
const state=(bundle,kind)=>bundle.operations.filter(o=>o.kind===kind&&ids.includes(o.register?.registerId));
test('LDXR defines canonical reservation state and STXR consumes then clears it',()=>{
  const load=liftArm64AtomicEffects({instructionId:'ldxr',mnemonic:'ldxr',ops:[gp(0),mem(1)]},{instructionId:'ldxr'});
  assert.equal(load.completeness,'exact-with-intrinsic');
  assert.deepEqual([...new Set(state(load,'register-write').map(o=>o.register.registerId))].sort(),[...ids].sort());
  const store=liftArm64AtomicEffects({instructionId:'stxr',mnemonic:'stxr',ops:[gp(2,32),gp(0),mem(1)]},{instructionId:'stxr'});
  assert.equal(store.completeness,'exact-with-intrinsic');
  assert.deepEqual([...new Set(state(store,'register-read').map(o=>o.register.registerId))].sort(),[...ids].sort());
  assert.deepEqual([...new Set(state(store,'register-write').map(o=>o.register.registerId))].sort(),[...ids].sort());
});
test('CLREX consumes and clears the same canonical reservation identities',()=>{
  const clear=liftArm64SystemEffects({instructionId:'clrex',mnemonic:'clrex',ops:[]},{instructionId:'clrex'});
  assert.equal(clear.completeness,'exact-with-intrinsic');
  assert.deepEqual([...new Set(state(clear,'register-read').map(o=>o.register.registerId))].sort(),[...ids].sort());
  assert.deepEqual([...new Set(state(clear,'register-write').map(o=>o.register.registerId))].sort(),[...ids].sort());
});
