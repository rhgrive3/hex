import fs from 'node:fs';
function edit(path,fn){const a=fs.readFileSync(path,'utf8'),b=fn(a);if(a===b)throw new Error('no change '+path);fs.writeFileSync(path,b)}
function once(s,a,b,label){const i=s.indexOf(a);if(i<0)throw new Error('missing '+label);if(s.indexOf(a,i+a.length)>=0)throw new Error('ambiguous '+label);return s.slice(0,i)+b+s.slice(i+a.length)}

edit('js/decompiler/pipeline-core.js',s=>{
  const old=`function compareFromFlags(flagValue, cond, state) {
  const d = flagValue?.def;
  if (!d || d.op !== 'cmp') return expr.variable('condition_' + (cond || 'flags'), 1, false);
  const a = buildArg(d.args?.[0], state);
  let b = buildArg(d.args?.[1], state);
  // ARM compare immediates inherit the register operand width. The IR wrapper
  // does not need to duplicate that width on the immediate itself, so canonicalize
  // the constant here before structural min/max matching.
  if (b?.kind === 'const' && a?.bits && b.bits !== a.bits) b = expr.constant(BigInt.asUintN(Number(a.bits), b.value), Number(a.bits), b.signed, b.source);
  const info = COND[cond] || null;
  const normal = info ? expr.compare(info.op, a, info.vsZero ? expr.constant(0, a.bits || 64) : b,
    info.signed == null ? signedFor(state, d.dst) : info.signed, origin(d))
    : expr.variable('condition_' + (cond || 'flags'), 1, false);
  if (!d.extra?.conditional) return normal;
  const previousFlags = valueOf(d.args?.[2]);
  const gate = compareFromFlags(previousFlags, d.cond, state);
  const fallbackTruth = nzcvCondition(d.extra?.fallbackNzcv, cond);
  const fallback = fallbackTruth == null ? expr.variable('fallback_' + (cond || 'flags'), 1, false)
    : expr.constant(fallbackTruth ? 1 : 0, 1, false, origin(d));
  return expr.select(gate, normal, fallback, 1, false, origin(d));
}`;
  const neu=`function compareFromFlags(flagValue, cond, state) {
  const d = flagValue?.def;
  if (!d || d.op !== 'cmp') return expr.variable('condition_' + (cond || 'flags'), 1, false);
  const a = buildArg(d.args?.[0], state);
  let b = buildArg(d.args?.[1], state);
  // ARM compare immediates inherit the register operand width. The IR wrapper
  // does not need to duplicate that width on the immediate itself, so canonicalize
  // the constant here before structural min/max matching (#356).
  if (b?.kind === 'const' && a?.bits && b.bits !== a.bits) b = expr.constant(BigInt.asUintN(Number(a.bits), b.value), Number(a.bits), b.signed, b.source);
  const map = { eq:['eq',null], ne:['ne',null], hs:['ge',false], cs:['ge',false], lo:['lt',false], cc:['lt',false], hi:['gt',false], ls:['le',false], ge:['ge',true], lt:['lt',true], gt:['gt',true], le:['le',true] };
  const info = map[cond] || null;
  let normal;
  // CMP/CCMP are subtraction flags, so the standard relational conditions map
  // directly to a comparison. CCMN is addition flags; do not lie by rendering
  // it as lhs<rhs. Preserve the exact condition as a semantic intrinsic when it
  // cannot be losslessly expressed by one ordinary C comparison.
  if (d.sub !== 'add' && info) normal = expr.compare(info[0], a, b, info[1], origin(d));
  else if (d.sub === 'add' && (cond === 'eq' || cond === 'ne')) {
    const sum = expr.binary('add', a, b, a.bits || b.bits || 64, null, origin(d));
    normal = expr.compare(cond, sum, expr.constant(0, sum.bits || 64), null, origin(d));
  } else if (cond === 'al' || cond === 'nv') normal = expr.constant(1, 1, false, origin(d));
  else normal = expr.intrinsic((d.sub === 'add' ? 'ccmn_' : 'cmp_') + (cond || 'flags'), [a,b], 1, false, origin(d), { nzcvCondition:true });
  if (!d.extra?.conditional) return normal;
  const previousFlags = valueOf(d.args?.[2]);
  const gate = compareFromFlags(previousFlags, d.extra?.cond, state);
  const fallbackTruth = nzcvCondition(d.extra?.fallbackNzcv, cond);
  const fallback = fallbackTruth == null ? expr.variable('fallback_' + (cond || 'flags'), 1, false, origin(d))
    : expr.constant(fallbackTruth ? 1 : 0, 1, false, origin(d));
  return expr.select(gate, normal, fallback, 1, false, origin(d));
}`;
  return once(s,old,neu,'#351 compare reconstruction');
});

edit('tests/issues-350-399.mjs',s=>{
  s=once(s,
`await test('#356 W-register reads keep 32-bit semantics',()=>{const rows=asm(['add w1, w0, #1','ret']);const rowOfAddress=a=>{const d=a-BASE;return d<0n||d>=8n?null:Number(d/4n)};const model=buildSemanticModel(rows,{startRow:0,endRow:1,rowOfAddress});const r=decompile(model,{addr:BASE,name:'widthRead',rowOfAddress,beginner:false});ok(/\\(uint32_t\\)a1/.test(r.pseudocode),r.pseudocode)});`,
`await test('#356 W-register reads keep 32-bit semantics',()=>{const rows=asm(['add w0, w0, #1','ret']);const rowOfAddress=a=>{const d=a-BASE;return d<0n||d>=8n?null:Number(d/4n)};const model=buildSemanticModel(rows,{startRow:0,endRow:1,rowOfAddress});const r=decompile(model,{addr:BASE,name:'widthRead',rowOfAddress,beginner:false});ok(/\\(uint32_t\\)a1/.test(r.pseudocode),r.pseudocode)});`,'#356 valid return fixture');
  return s;
});
