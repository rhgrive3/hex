/* AAPCS64 prototype recovery driven by actual SSA uses and recovered type evidence. */

function tname(t, fallback = 'unknown') { return t?.name || t?.type || fallback; }
function used(v) { return (v?.uses || []).some((u) => u && !u.clobbered); }

export function recoverFunctionPrototype(ir, types, opts = {}) {
  const args = [];
  let lastUsed = -1;
  for (let i = 0; i < 8; i++) {
    const v = ir?.args?.get?.(`x${i}`) || null;
    if (v && used(v)) lastUsed = i;
  }
  // AAPCS64 does not permit silently deleting a hole before a later used argument.
  for (let i = 0; i <= lastUsed; i++) {
    const v = ir?.args?.get?.(`x${i}`) || null;
    const recovered = v ? types?.values?.get?.(v.id) : null;
    args.push({ index:i, reg:`x${i}`, name:opts.argNames?.[i] || `arg${i+1}`, type:tname(recovered), confidence:recovered?.confidence || (v ? 0.45 : 0.2), valueId:v?.id ?? null, used:!!v && used(v) });
  }
  const x8 = ir?.args?.get?.('x8');
  const indirectResult = !!(x8 && used(x8) && (types?.values?.get?.(x8.id)?.kind === 'pointer' || opts.indirectResult));
  const ret = types?.ret || null;
  const retType = tname(ret, opts.returnType || 'unknown');
  return {
    convention:'AAPCS64', arguments:args, returnType:retType,
    returnConfidence:ret?.confidence || 0.35,
    indirectResult, indirectResultRegister:indirectResult ? 'x8' : null,
    variadic:opts.variadic === true,
    evidence:[
      ...(args.length ? ['entry SSA use of x0..x7'] : []),
      ...(indirectResult ? ['x8 used as typed indirect-result pointer'] : []),
      ...(ret ? ['semantic return-type evidence'] : []),
    ],
  };
}
