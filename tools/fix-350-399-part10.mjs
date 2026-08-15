import fs from 'node:fs';
const path='js/decompiler/rewrite/rules.js';
let s=fs.readFileSync(path,'utf8');
const old=`    const q = n.condition;
    const ta = sameExpr(n.whenTrue, q.left), tb = sameExpr(n.whenTrue, q.right);
    const fa = sameExpr(n.whenFalse, q.left), fb = sameExpr(n.whenFalse, q.right);`;
const neu=`    const q = n.condition;
    // Constant signedness/nominal width is metadata; select equivalence is over
    // the result bitvector. This keeps WZR and #0 equivalent after width-aware
    // operand reconstruction while retaining strict structural matching for
    // non-constant expressions.
    const sameArm = (a,b) => sameExpr(a,b) || (isConst(a) && isConst(b)
      && BigInt.asUintN(Number(n.bits || q.left?.bits || 64), a.value) === BigInt.asUintN(Number(n.bits || q.left?.bits || 64), b.value));
    const ta = sameArm(n.whenTrue, q.left), tb = sameArm(n.whenTrue, q.right);
    const fa = sameArm(n.whenFalse, q.left), fb = sameArm(n.whenFalse, q.right);`;
if(!s.includes(old))throw new Error('select-min-max match target missing');
s=s.replace(old,neu);
fs.writeFileSync(path,s);
