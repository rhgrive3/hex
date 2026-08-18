from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, got {count}: {old[:140]!r}')
    p.write_text(text.replace(old, new, 1))

# #803 + #833: keep raw FP bits in the emulator and perform true fused FMA.
replace_once('js/emu.js', '    this.v = new Array(32).fill(0);', '    this.v = new Array(32).fill(0n);')
replace_once('js/emu.js', "      if (isFloatReg(ops[0])) this.v[ops[0].num] = bitsToFloat(v, size);\n      else this.set(ops[0].text, v);",
'''      if (isFloatReg(ops[0])) this.setFpBits(ops[0], v);
      else this.set(ops[0].text, v);''')
replace_once('js/emu.js', "        if (isFloatReg(ops[first])) await this.store(addr,size,floatToBits(this.fget(ops[first]),size));\n        else await this.store(addr,size,this.get(ops[first].text));",
'''        if (isFloatReg(ops[first])) await this.store(addr,size,this.fpBits(ops[first]));
        else await this.store(addr,size,this.get(ops[first].text));''')
replace_once('js/emu.js', "    } else if (isFloatReg(ops[first])) await this.store(addr,size,floatToBits(this.fget(ops[first]),size));",
"    } else if (isFloatReg(ops[first])) await this.store(addr,size,this.fpBits(ops[first]));")
replace_once('js/emu.js', '''  fget(op) {
    if (!op || op.k !== 'reg') return 0;
    if (op.cls === 'gp' || op.cls === 'sp') {
      const bits = op.bits === 32 ? 32 : 64;
      return Number(BigInt.asIntN(bits,this.get(op.text)));
    }
    const value=this.v[op.num];
    return value === undefined ? 0 : value;
  }

  fset(op,value) {
    if (!op || op.k !== 'reg') return;
    if (op.cls === 'gp') { this.set(op.text,BigInt(Math.trunc(value))); return; }
    this.v[op.num] = op.bits === 32 || /^s\\d+$/i.test(op.text || '') ? Math.fround(value) : value;
  }''', '''  fpSize(op) {
    return op?.bits === 32 || /^s\\d+$/i.test(op?.text || '') ? 4 : 8;
  }

  fpBits(op) {
    if (!op || op.k !== 'reg' || !isFloatReg(op)) return 0n;
    const size = this.fpSize(op);
    const mask = size === 4 ? 0xffffffffn : MASK64;
    return BigInt.asUintN(size * 8, this.v[op.num] ?? 0n) & mask;
  }

  setFpBits(op, bits) {
    if (!op || op.k !== 'reg' || !isFloatReg(op)) return;
    const size = this.fpSize(op);
    this.v[op.num] = BigInt.asUintN(size * 8, BigInt(bits));
  }

  fget(op) {
    if (!op || op.k !== 'reg') return 0;
    if (op.cls === 'gp' || op.cls === 'sp') {
      const bits = op.bits === 32 ? 32 : 64;
      return Number(BigInt.asIntN(bits,this.get(op.text)));
    }
    return bitsToFloat(this.fpBits(op), this.fpSize(op));
  }

  fset(op,value) {
    if (!op || op.k !== 'reg') return;
    if (op.cls === 'gp') { this.set(op.text,BigInt(Math.trunc(value))); return; }
    const size = this.fpSize(op);
    this.setFpBits(op, floatToBits(size === 4 ? Math.fround(value) : value, size));
  }''')
replace_once('js/emu.js', "    if (mn === 'fmov') { if (ops[1]?.k === 'imm') this.fset(ops[0],ops[1].float != null ? ops[1].float : Number(ops[1].value || 0n)); else this.fset(ops[0],a); return null; }",
'''    if (mn === 'fmov') {
      if (ops[1]?.k === 'imm') {
        this.fset(ops[0], ops[1].float != null ? ops[1].float : Number(ops[1].value || 0n));
      } else if (isFloatReg(ops[0]) && (ops[1]?.cls === 'gp' || ops[1]?.cls === 'sp')) {
        this.setFpBits(ops[0], this.get(ops[1].text));
      } else if ((ops[0]?.cls === 'gp' || ops[0]?.cls === 'sp') && isFloatReg(ops[1])) {
        this.set(ops[0].text, this.fpBits(ops[1]));
      } else if (isFloatReg(ops[0]) && isFloatReg(ops[1])) {
        this.setFpBits(ops[0], this.fpBits(ops[1]));
      } else {
        throw new EmulatorFault('invalid-fmov-form', 'unsupported FMOV operand form');
      }
      return null;
    }''')
replace_once('js/emu.js', "    if (mn === 'fmadd') { this.fset(ops[0],this.fget(ops[3])+a*b); return null; }\n    if (mn === 'fmsub') { this.fset(ops[0],this.fget(ops[3])-a*b); return null; }",
'''    if (mn === 'fmadd' || mn === 'fmsub' || mn === 'fnmadd' || mn === 'fnmsub') {
      const size = this.fpSize(ops[0]);
      const negateProduct = mn === 'fmsub' || mn === 'fnmadd';
      const negateResult = mn === 'fnmadd' || mn === 'fnmsub';
      let raw = fusedMultiplyAddBits(this.fpBits(ops[1]), this.fpBits(ops[2]), this.fpBits(ops[3]), size, negateProduct);
      if (negateResult) raw ^= size === 4 ? 0x80000000n : 0x8000000000000000n;
      this.setFpBits(ops[0], raw);
      return null;
    }''')

insert_point = '''function padTo(bytes, len) {'''
fma_helpers = r'''function fpFormat(size) {
  return size === 4
    ? { bits:32, fracBits:23, expBits:8, bias:127, emin:-126, emax:127 }
    : { bits:64, fracBits:52, expBits:11, bias:1023, emin:-1022, emax:1023 };
}

function decodeFp(bits, size) {
  const f = fpFormat(size);
  const raw = BigInt.asUintN(f.bits, BigInt(bits));
  const sign = Number((raw >> BigInt(f.bits - 1)) & 1n);
  const expMask = (1n << BigInt(f.expBits)) - 1n;
  const fracMask = (1n << BigInt(f.fracBits)) - 1n;
  const expField = Number((raw >> BigInt(f.fracBits)) & expMask);
  const frac = raw & fracMask;
  if (expField === Number(expMask)) return { kind:frac === 0n ? 'inf' : 'nan', sign, raw, frac };
  if (expField === 0) {
    if (frac === 0n) return { kind:'zero', sign, raw, coefficient:0n, exponent:0 };
    return { kind:'finite', sign, raw, coefficient:(sign ? -frac : frac), exponent:1 - f.bias - f.fracBits };
  }
  const significand = (1n << BigInt(f.fracBits)) | frac;
  return { kind:'finite', sign, raw, coefficient:sign ? -significand : significand, exponent:expField - f.bias - f.fracBits };
}

function defaultQuietNaN(size) {
  const f = fpFormat(size);
  const expMask = (1n << BigInt(f.expBits)) - 1n;
  return (expMask << BigInt(f.fracBits)) | (1n << BigInt(f.fracBits - 1));
}

function quietNaN(decoded, size) {
  const f = fpFormat(size);
  return decoded.raw | (1n << BigInt(f.fracBits - 1));
}

function roundShiftRightEven(value, shift) {
  if (shift <= 0) return value << BigInt(-shift);
  const s = BigInt(shift);
  const q = value >> s;
  const rem = value - (q << s);
  const half = 1n << (s - 1n);
  return rem > half || (rem === half && (q & 1n)) ? q + 1n : q;
}

function encodeExactFp(coefficient, exponent, size, zeroSign = 0) {
  const f = fpFormat(size);
  const signBit = 1n << BigInt(f.bits - 1);
  if (coefficient === 0n) return zeroSign ? signBit : 0n;
  const negative = coefficient < 0n;
  let n = negative ? -coefficient : coefficient;
  let top = n.toString(2).length - 1;
  let unbiased = top + exponent;
  const precision = f.fracBits + 1;
  let significand;
  if (unbiased >= f.emin) {
    significand = roundShiftRightEven(n, top - (precision - 1));
    if (significand >= (1n << BigInt(precision))) { significand >>= 1n; unbiased += 1; }
    if (unbiased > f.emax) {
      const expAll = (1n << BigInt(f.expBits)) - 1n;
      return (negative ? signBit : 0n) | (expAll << BigInt(f.fracBits));
    }
    if (unbiased >= f.emin) {
      const expField = BigInt(unbiased + f.bias);
      const fraction = significand - (1n << BigInt(f.fracBits));
      return (negative ? signBit : 0n) | (expField << BigInt(f.fracBits)) | fraction;
    }
  }
  const subnormalExponent = f.emin - f.fracBits;
  const delta = exponent - subnormalExponent;
  const fraction = delta >= 0 ? n << BigInt(delta) : roundShiftRightEven(n, -delta);
  if (fraction === 0n) return negative ? signBit : 0n;
  if (fraction >= (1n << BigInt(f.fracBits))) {
    return (negative ? signBit : 0n) | (1n << BigInt(f.fracBits));
  }
  return (negative ? signBit : 0n) | fraction;
}

function fusedMultiplyAddBits(aBits, bBits, cBits, size, negateProduct = false) {
  const a = decodeFp(aBits, size), b = decodeFp(bBits, size), c = decodeFp(cBits, size);
  for (const value of [a,b,c]) if (value.kind === 'nan') return quietNaN(value, size);
  const productSign = a.sign ^ b.sign ^ (negateProduct ? 1 : 0);
  if ((a.kind === 'inf' && b.kind === 'zero') || (a.kind === 'zero' && b.kind === 'inf')) return defaultQuietNaN(size);
  if (a.kind === 'inf' || b.kind === 'inf') {
    if (c.kind === 'inf' && c.sign !== productSign) return defaultQuietNaN(size);
    const f = fpFormat(size), signBit = 1n << BigInt(f.bits - 1), expAll = (1n << BigInt(f.expBits)) - 1n;
    return (productSign ? signBit : 0n) | (expAll << BigInt(f.fracBits));
  }
  if (c.kind === 'inf') return c.raw;

  let productCoefficient = (a.coefficient ?? 0n) * (b.coefficient ?? 0n);
  if (negateProduct) productCoefficient = -productCoefficient;
  const productExponent = (a.exponent ?? 0) + (b.exponent ?? 0);
  const cCoefficient = c.coefficient ?? 0n;
  if (productCoefficient === 0n && cCoefficient === 0n) {
    const zeroSign = productSign === c.sign ? productSign : 0;
    return encodeExactFp(0n, 0, size, zeroSign);
  }
  if (productCoefficient === 0n) return encodeExactFp(cCoefficient, c.exponent ?? 0, size, c.sign);
  if (cCoefficient === 0n) return encodeExactFp(productCoefficient, productExponent, size, productSign);
  const commonExponent = Math.min(productExponent, c.exponent);
  const exact = (productCoefficient << BigInt(productExponent - commonExponent))
    + (cCoefficient << BigInt(c.exponent - commonExponent));
  return encodeExactFp(exact, commonExponent, size, 0);
}

'''
replace_once('js/emu.js', insert_point, fma_helpers + insert_point)

# #809: all scalar FP/SIMD accesses use one canonical 128-bit vN physical state.
replace_once('js/targets/architecture/arm64/effects/fp.js', '''function appendRegisterRead(operations, op, valueType, id) {
  const reg = registerValue(op, valueType?.widthBits || scalarWidth(op));
  if (!reg) return null;
  const value = temp(id, valueType);
  operations.push(createMachineOperation({ kind: 'register-read', register: reg, value }));
  return value;
}''', '''function appendRegisterRead(operations, op, valueType, id) {
  if (op?.k === 'reg' && (op.cls === 'fp' || op.cls === 'vec')) {
    const physicalType = bitType(128);
    const physical = temp(`${id}:physical`, physicalType);
    operations.push(createMachineOperation({
      kind:'register-read',
      register:createRegisterValue(physicalRegisterId(op), 128, { view:`v${op.num}` }),
      value:physical,
    }));
    if (valueType?.kind === 'bitvector' && valueType.widthBits === 128) return physical;
    const value = temp(id, valueType);
    operations.push(createMachineOperation({
      kind:'value', opcode:'arm64.simd.extract-low-view', inputs:[physical], outputs:[value],
      metadata:{ view:String(op.text || '').toLowerCase(), widthBits:valueType?.widthBits || scalarWidth(op) },
    }));
    return value;
  }
  const reg = registerValue(op, valueType?.widthBits || scalarWidth(op));
  if (!reg) return null;
  const value = temp(id, valueType);
  operations.push(createMachineOperation({ kind: 'register-read', register: reg, value }));
  return value;
}''')
replace_once('js/targets/architecture/arm64/effects/fp.js', '''  operations.push(createMachineOperation({
    kind: 'register-write',
    register: registerValue(dst, scalarWidth(dst)),
    value: semanticValue,
  }));
}''', '''  if (dst.cls === 'fp' || dst.cls === 'vec') {
    const id = physicalRegisterId(dst);
    const bits = scalarWidth(dst);
    const physical = temp(`${idPrefix}:physical-write`, bitType(128));
    operations.push(createMachineOperation({
      kind:'value', opcode:'arm64.simd.scalar-write-zero-upper', inputs:[semanticValue], outputs:[physical],
      metadata:{ sourceWidthBits:bits, destinationWidthBits:128, architecturalViewWritten:String(dst.text || id).toLowerCase() },
    }));
    operations.push(createMachineOperation({
      kind:'register-write', register:createRegisterValue(id, 128, { view:id }), value:physical,
      metadata:{ architecturalViewWritten:String(dst.text || id).toLowerCase() },
    }));
    return;
  }
  operations.push(createMachineOperation({
    kind: 'register-write',
    register: registerValue(dst, scalarWidth(dst)),
    value: semanticValue,
  }));
}''')

# #811: distinguish _ZTV symbol base from the vtable address-point header and bounded-scan only with typeinfo evidence.
replace_once('js/rtti.js', "if(m[1]==='TV')e.vtable=symbols.addrs[i];if(m[1]==='TI')e.typeinfo=symbols.addrs[i];if(m[1]==='TS')e.typeName=symbols.addrs[i];",
"if(m[1]==='TV'){e.vtable=symbols.addrs[i];e.vtableSymbolBase=symbols.addrs[i];e.vtableAddressPoint=null;e.vtableAddressKind='symbol-base';}if(m[1]==='TI')e.typeinfo=symbols.addrs[i];if(m[1]==='TS')e.typeName=symbols.addrs[i];")
replace_once('js/rtti.js', '''  const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),slots=[];
  const offsetToTop=BigInt.asIntN(64,dv.getBigUint64(0,true));
  const typeinfoRaw=dv.getBigUint64(8,true);
  const typeinfoResolved=await resolveVtablePointer(typeinfoRaw,BigInt(vtableAddr)+8n,opts||{});
  for(let i=2;i*8+8<=bytes.length;i++){
    const raw=dv.getBigUint64(i*8,true);
    if(raw===0n)break;
    const resolved=await resolveVtablePointer(raw,BigInt(vtableAddr)+BigInt(i*8),opts||{});
    const addr=resolved.addr;
    const name=addr!=null&&addr!==0n&&symbols?(symbols.nameAt(addr)||symbols.label(addr)):null;
    slots.push({index:i-2,raw,addr,binding:resolved.binding||null,unresolved:!!resolved.unresolved,reason:resolved.reason||null,name:name||null,readable:name?readableName(name):null});
  }
  return{addr:vtableAddr,offsetToTop,typeinfo:typeinfoResolved.addr,typeinfoRaw,typeinfoBinding:typeinfoResolved.binding||null,typeinfoUnresolved:!!typeinfoResolved.unresolved,slots};''', '''  const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),slots=[];
  let headerIndex=0;
  if(opts?.symbolBase===true||opts?.addressKind==='symbol-base'){
    const maxPrefix=Math.max(0,Math.min(64,Number(opts?.maxPrefixEntries??16)||16));
    headerIndex=-1;
    for(let candidate=0;candidate<=maxPrefix&&((candidate+2)*8)<=bytes.length;candidate++){
      const raw=dv.getBigUint64((candidate+1)*8,true);
      const resolved=await resolveVtablePointer(raw,BigInt(vtableAddr)+BigInt((candidate+1)*8),opts||{});
      const name=resolved.addr!=null&&symbols?(symbols.nameAt?.(resolved.addr)||symbols.label?.(resolved.addr)):null;
      const expected=opts?.typeinfoAddress==null?null:BigInt(opts.typeinfoAddress);
      if((expected!=null&&resolved.addr===expected)||(name&&/^_?_ZTI/.test(name))){headerIndex=candidate;break;}
    }
    if(headerIndex<0)return{addr:vtableAddr,addressPoint:null,unresolved:true,reason:'vtable-address-point-unresolved',offsetToTop:null,typeinfo:null,typeinfoRaw:null,typeinfoUnresolved:true,slots:[]};
  }
  const offsetToTop=BigInt.asIntN(64,dv.getBigUint64(headerIndex*8,true));
  const typeinfoRaw=dv.getBigUint64((headerIndex+1)*8,true);
  const typeinfoResolved=await resolveVtablePointer(typeinfoRaw,BigInt(vtableAddr)+BigInt((headerIndex+1)*8),opts||{});
  const addressPoint=BigInt(vtableAddr)+BigInt((headerIndex+2)*8);
  for(let i=headerIndex+2;i*8+8<=bytes.length;i++){
    const raw=dv.getBigUint64(i*8,true);
    if(raw===0n)break;
    const resolved=await resolveVtablePointer(raw,BigInt(vtableAddr)+BigInt(i*8),opts||{});
    const addr=resolved.addr;
    const name=addr!=null&&addr!==0n&&symbols?(symbols.nameAt?.(addr)||symbols.label?.(addr)):null;
    slots.push({index:i-(headerIndex+2),raw,addr,binding:resolved.binding||null,unresolved:!!resolved.unresolved,reason:resolved.reason||null,name:name||null,readable:name?readableName(name):null});
  }
  return{addr:vtableAddr,addressPoint,headerIndex,offsetToTop,typeinfo:typeinfoResolved.addr,typeinfoRaw,typeinfoBinding:typeinfoResolved.binding||null,typeinfoUnresolved:!!typeinfoResolved.unresolved,slots};''')

print('guarded batch B source patch applied')
