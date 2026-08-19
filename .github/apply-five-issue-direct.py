from pathlib import Path

SOURCE = Path('.github/apply-five-issue-fix-source.yml.txt')
text = SOURCE.read_text()
marker = "          python3 - <<'PY'\n"
start = text.index(marker) + len(marker)
end = text.index("\n          PY\n", start)
lines = text[start:end].splitlines()
script = '\n'.join(line[10:] if line.startswith('          ') else line for line in lines) + '\n'

# The AAPCS64 #925/#926 implementation is already committed on this branch.
# Reuse the audited source patch for #932/#948 and replace only the known-bad
# #935 section with the physical-state-preserving implementation.
helper_end = script.index('# #925/#926:')
remaining_start = script.index('# #932:')
helper = script[:helper_end]
remaining = script[remaining_start:]
x86_start = remaining.index('# #935: zero effective count')
x86_end = remaining.index('# #948: element reads', x86_start)
robust_x86 = r'''# #935: zero effective count performs no architectural write; unknown zero path preserves old physical state.
p = Path('js/targets/architecture/x86_64/effects/integer.js')
text = p.read_text()
start = text.index("    if (count.knownCount === 0) {")
end = text.index("    const value = ctx.readRegister(destination);", start)
replacement = """    if (count.knownCount === 0) {
      return ctx.finish({
        family:'integer',
        statePreservation:{ proven:true, reason:`x86-${family}-zero-effective-count-preserves-physical-destination-and-flags` },
        metadata:{ operation:family, widthBits:destination.widthBits, effectiveCount:0, destinationWrite:false, flagsPreserved:true },
      });
    }
"""
text = text[:start] + replacement + text[end:]
old = "      if (!writeConditionalRegister(ctx, destination, nonzero, result, { falseValue:value })) {"
if text.count(old) != 1:
    raise SystemExit(f'x86 unknown-count anchor expected once, found {text.count(old)}')
text = text.replace(old, "      if (!writeConditionalRegister(ctx, destination, nonzero, result)) {", 1)
p.write_text(text)

'''
remaining = remaining[:x86_start] + robust_x86 + remaining[x86_end:]
exec(compile(helper + remaining, '/tmp/apply-five-issue-remaining.py', 'exec'), {'Path': Path})

# Harden the generated focused test around the exact state-model boundaries.
test_path = Path('tests/issues-925-926-932-935-948.mjs')
test_text = test_path.read_text()
bad_nzcv = "  assert.doesNotMatch(system, /sys === 'nzcv'[\\s\\S]{0,600}registersWritten:\\[sysRegId\\(sys\\)\\]/);\n"
good_nzcv = """  const mrsBody = system.slice(system.indexOf('function mrs('), system.indexOf('function msr('));
  const msrBody = system.slice(system.indexOf('function msr('), system.indexOf('function maintenance('));
  assert.match(mrsBody, /if \\(sys === 'nzcv'\\)[\\s\\S]*canonicalState:'PSTATE\\.NZCV'/);
  assert.match(msrBody, /if \\(sys === 'nzcv'\\)[\\s\\S]*canonicalState:'PSTATE\\.NZCV'/);
  const mrsNzcv = mrsBody.slice(mrsBody.indexOf("if (sys === 'nzcv')"), mrsBody.indexOf('const operation = completeIntrinsic', mrsBody.indexOf("if (sys === 'nzcv')")));
  const msrNzcv = msrBody.slice(msrBody.indexOf("if (sys === 'nzcv')"), msrBody.indexOf('const operation = completeIntrinsic', msrBody.indexOf("if (sys === 'nzcv')")));
  assert.doesNotMatch(mrsNzcv, /sysRegId\\(sys\\)/);
  assert.doesNotMatch(msrNzcv, /sysRegId\\(sys\\)/);
"""
if test_text.count(bad_nzcv) == 1:
    test_text = test_text.replace(bad_nzcv, good_nzcv, 1)
bad_zero = "  const zeroBlock = integer.slice(integer.indexOf('if (count.knownCount === 0)'), integer.indexOf('const value = ctx.readRegister(destination)'));\n"
good_zero = "  const zeroStart = integer.indexOf('if (count.knownCount === 0)');\n  const zeroBlock = integer.slice(zeroStart, integer.indexOf('const value = ctx.readRegister(destination)', zeroStart));\n"
if test_text.count(bad_zero) == 1:
    test_text = test_text.replace(bad_zero, good_zero, 1)
marker2 = "\n// #932/#935/#948 structural invariants protect the exact state-model boundary.\n"
if marker2 not in test_text:
    raise SystemExit('focused test insertion marker missing')
if '// #925/#926 acceptance-boundary regressions.' not in test_text:
    insert = """
// #925/#926 acceptance-boundary regressions.
{
  const one = classify([{ type:'struct One', aggregate:true, bits:64 }]);
  assert.deepEqual(one.arguments[0].regs, ['x0']);
  const union = classify([{ type:'union U', bits:128 }]);
  assert.equal(union.arguments[0].abiClass, 'aggregate');
  assert.deepEqual(union.arguments[0].regs, ['x0','x1']);
  const split = classify([
    ...Array.from({length:7}, () => ({ type:'uint64_t', bits:64 })),
    { type:'struct Pair', aggregate:true, bits:128 },
  ]);
  assert.equal(split.arguments[7].location, 'register-stack');
  assert.deepEqual(split.arguments[7].regs, ['x7']);
  assert.equal(split.arguments[7].stackBytes, 8);
  assert.equal(split.stackArguments.at(-1).pieceOffsetBytes, 8);
  const aligned = classify([{type:'uint64_t',bits:64},{type:'struct Pair',aggregate:true,bits:128,alignment:16}]);
  assert.deepEqual(aligned.arguments[1].regs, ['x2','x3']);
  const wide6 = classify([...Array.from({length:6},()=>({type:'uint64_t',bits:64})),{type:'__int128'}]);
  assert.deepEqual(wide6.arguments[6].regs, ['x6','x7']);
  const unsigned = classify([{type:'unsigned __int128'}]);
  assert.deepEqual(unsigned.arguments[0].regs, ['x0','x1']);
  const hfa = classify([{type:'struct H',hfa:true,members:2,bits:64}]);
  assert.deepEqual(hfa.arguments[0].regs, ['v0','v1']);
  const hfaExhaust = classify([
    {type:'struct H7',hfa:true,members:4,bits:32},
    {type:'struct H4',hfa:true,members:4,bits:32},
    {type:'struct H2',hfa:true,members:2,bits:32},
  ]);
  assert.equal(hfaExhaust.arguments[2].location, 'stack');
}
"""
    test_text = test_text.replace(marker2, insert + marker2, 1)
test_path.write_text(test_text)
