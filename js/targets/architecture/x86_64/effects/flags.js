const ARITHMETIC_FLAGS = Object.freeze(['CF','PF','AF','ZF','SF','OF']);

export function emitX86ArithmeticFlags(ctx, operation, left, right, result, widthBits) {
  const outputs = ctx.intrinsic(`x86.flags.${operation}`, [left,right,result], ARITHMETIC_FLAGS.map(() => 1), {
    determinism:'input-dependent',
    symbolicDetail:'summary-only',
    metadata:{ flags:ARITHMETIC_FLAGS, widthBits, exactArchitecturalSummary:true },
  });
  ARITHMETIC_FLAGS.forEach((flag, index) => ctx.writeFlag(flag, outputs[index], { operation, widthBits }));
}

export function emitX86LogicalFlags(ctx, operation, left, right, result, widthBits) {
  const outputs = ctx.intrinsic(`x86.flags.${operation}`, [left,right,result], ARITHMETIC_FLAGS.map(() => 1), {
    determinism:'nondeterministic',
    symbolicDetail:'summary-only',
    metadata:{
      flags:ARITHMETIC_FLAGS,
      widthBits,
      fixed:Object.freeze({ CF:0, OF:0 }),
      undefined:Object.freeze(['AF']),
      inputDependent:Object.freeze(['PF','ZF','SF']),
      exactArchitecturalSummary:true,
    },
  });
  ARITHMETIC_FLAGS.forEach((flag, index) => ctx.writeFlag(flag, outputs[index], { operation, widthBits }));
}

export function emitX86Condition(ctx, conditionCode) {
  const code = String(conditionCode || '').toLowerCase();
  const flagsByCondition = {
    e:['ZF'], z:['ZF'], ne:['ZF'], nz:['ZF'],
    a:['CF','ZF'], nbe:['CF','ZF'], ae:['CF'], nb:['CF'], nc:['CF'],
    b:['CF'], c:['CF'], nae:['CF'], be:['CF','ZF'], na:['CF','ZF'],
    g:['ZF','SF','OF'], nle:['ZF','SF','OF'], ge:['SF','OF'], nl:['SF','OF'],
    l:['SF','OF'], nge:['SF','OF'], le:['ZF','SF','OF'], ng:['ZF','SF','OF'],
    s:['SF'], ns:['SF'], o:['OF'], no:['OF'], p:['PF'], pe:['PF'], np:['PF'], po:['PF'],
  };
  const names = flagsByCondition[code];
  if (!names) return null;
  const inputs = names.map((name) => ctx.readFlag(name));
  return ctx.intrinsic(`x86.condition.${code}`, inputs, [1], {
    determinism:'input-dependent',
    symbolicDetail:'summary-only',
    metadata:{ conditionCode:code, flags:names, exactArchitecturalSummary:true },
  })[0];
}
