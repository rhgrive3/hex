from pathlib import Path


def replace_once(path, old, new):
    p=Path(path); text=p.read_text(); count=text.count(old)
    if count != 1: raise SystemExit(f'{path}: expected one post-batch-B match, got {count}: {old[:150]!r}')
    p.write_text(text.replace(old,new,1))

# Post-batch-B hardening for #809. Exact bitwise scalar writes can use the
# explicit zero-upper projection, while FP-environment/select operations return
# the complete 128-bit physical V-register state from their intrinsic because
# FPCR alternative behavior can affect the upper-lane merge rule.
replace_once('js/targets/architecture/arm64/effects/fp.js',
'''  const av = sourceValue(operations, a, type, 'fcsel:src0');
  const bv = sourceValue(operations, b, type, 'fcsel:src1');
  const flags = appendNamedRegisterRead(operations, NZCV, 4, 'fcsel:nzcv');
  const result = temp('fcsel:result', type);
  const summary = createIntrinsicEffectSummary({
    inputs: [av, bv, flags],
    outputs: [result],
    registersRead: [...registerIdsOf([a,b]), NZCV],
    registersWritten: registerIdsOf([dst]),''',
'''  const av = sourceValue(operations, a, type, 'fcsel:src0');
  const bv = sourceValue(operations, b, type, 'fcsel:src1');
  const flags = appendNamedRegisterRead(operations, NZCV, 4, 'fcsel:nzcv');
  const fpcr = appendNamedRegisterRead(operations, FPCR, 32, 'fcsel:fpcr');
  const oldPhysical = appendRegisterRead(operations, dst, bitType(128), 'fcsel:old-dst-physical');
  const result = temp('fcsel:result', type);
  const physicalResult = temp('fcsel:physical-result', bitType(128));
  const summary = createIntrinsicEffectSummary({
    inputs: [av, bv, flags, fpcr, oldPhysical],
    outputs: [result, physicalResult],
    registersRead: [...new Set([...registerIdsOf([a,b,dst]), NZCV, FPCR])],
    registersWritten: registerIdsOf([dst]),''')
replace_once('js/targets/architecture/arm64/effects/fp.js',
'''    metadata: { condition: ops.find((op) => op?.k === 'cond')?.text || null, widthBits: width },
  }));
  appendDestinationWrite(operations, dst, result, 'fcsel:dst');
  return bundle(instruction, context, { operations, completeness: 'exact-with-intrinsic', metadata: { widthBits: width } });''',
'''    metadata: {
      condition: ops.find((op) => op?.k === 'cond')?.text || null,
      widthBits: width,
      physicalDestinationWidthBits:128,
      upperLaneBehavior:'fpcr-dependent-architectural-intrinsic',
    },
  }));
  operations.push(createMachineOperation({
    kind:'register-write',
    register:createRegisterValue(physicalRegisterId(dst), 128, { view:physicalRegisterId(dst) }),
    value:physicalResult,
    metadata:{ architecturalViewWritten:String(dst.text || physicalRegisterId(dst)).toLowerCase(), upperLaneBehavior:'fpcr-dependent-architectural-intrinsic' },
  }));
  return bundle(instruction, context, { operations, completeness: 'exact-with-intrinsic', metadata: { widthBits: width, physicalDestinationWidthBits:128 } });''')

replace_once('js/targets/architecture/arm64/effects/fp.js',
'''  const fpcr = appendNamedRegisterRead(operations, FPCR, 32, `${mnemonic}:fpcr`);
  const oldFpsr = appendNamedRegisterRead(operations, FPSR, 32, `${mnemonic}:fpsr`);
  inputs.push(fpcr, oldFpsr);

  const result = temp(`${mnemonic}:result`, resultType);
  const newFpsr = temp(`${mnemonic}:fpsr-out`, bitType(32));
  const outputs = [result, newFpsr];
  const registersRead = [...registerIdsOf(sourceOps), FPCR, FPSR];
  const registersWritten = [...registerIdsOf([dst]), FPSR];''',
'''  const fpcr = appendNamedRegisterRead(operations, FPCR, 32, `${mnemonic}:fpcr`);
  const oldFpsr = appendNamedRegisterRead(operations, FPSR, 32, `${mnemonic}:fpsr`);
  inputs.push(fpcr, oldFpsr);

  const scalarDestination = dst.cls === 'fp' || dst.cls === 'vec';
  let oldPhysical = null;
  if (scalarDestination) {
    oldPhysical = appendRegisterRead(operations, dst, bitType(128), `${mnemonic}:old-dst-physical`);
    inputs.push(oldPhysical);
  }
  const result = temp(`${mnemonic}:result`, resultType);
  const physicalResult = scalarDestination ? temp(`${mnemonic}:physical-result`, bitType(128)) : null;
  const newFpsr = temp(`${mnemonic}:fpsr-out`, bitType(32));
  const outputs = physicalResult ? [result, physicalResult, newFpsr] : [result, newFpsr];
  const registersRead = [...new Set([...registerIdsOf(sourceOps), ...(scalarDestination ? registerIdsOf([dst]) : []), FPCR, FPSR])];
  const registersWritten = [...registerIdsOf([dst]), FPSR];''')
replace_once('js/targets/architecture/arm64/effects/fp.js',
'''      nanAndExceptionSemantics: 'architectural-intrinsic',
    },
  }));
  appendDestinationWrite(operations, dst, result, `${mnemonic}:dst`);
  appendNamedRegisterWrite(operations, FPSR, 32, newFpsr);''',
'''      nanAndExceptionSemantics: 'architectural-intrinsic',
      physicalDestinationWidthBits: scalarDestination ? 128 : null,
      upperLaneBehavior: scalarDestination ? 'fpcr-dependent-architectural-intrinsic' : null,
    },
  }));
  if (physicalResult) {
    operations.push(createMachineOperation({
      kind:'register-write',
      register:createRegisterValue(physicalRegisterId(dst), 128, { view:physicalRegisterId(dst) }),
      value:physicalResult,
      metadata:{ architecturalViewWritten:String(dst.text || physicalRegisterId(dst)).toLowerCase(), upperLaneBehavior:'fpcr-dependent-architectural-intrinsic' },
    }));
  } else {
    appendDestinationWrite(operations, dst, result, `${mnemonic}:dst`);
  }
  appendNamedRegisterWrite(operations, FPSR, 32, newFpsr);''')
replace_once('js/targets/architecture/arm64/effects/fp.js',
'''    metadata: { destinationWidthBits: dstWidth, roundingMode: roundingMode(mnemonic) },
  });''',
'''    metadata: { destinationWidthBits: dstWidth, physicalDestinationWidthBits: scalarDestination ? 128 : null, roundingMode: roundingMode(mnemonic) },
  });''')

print('guarded batch B2 FPCR physical-state hardening applied')
