import { createX86DecodedInstruction } from '../../../../js/targets/architecture/x86_64/decoded-instruction.js';

let sequence = 0;
export function reg(name, widthBits = null, access = 'unknown') { return { type:'register', register:name, ...(widthBits == null ? {} : { widthBits }), access }; }
export function imm(value, widthBits = null, encodedWidthBits = null) { return { type:'immediate', value:BigInt(value), ...(widthBits == null ? {} : { widthBits }), ...(encodedWidthBits == null ? {} : { encodedWidthBits }), access:'unknown' }; }
export function mem({ base=null,index=null,scale=1,displacement=0n,segment=null,widthBits=64,addressSizeBits=64,access='read' }={}) { return { type:'memory', widthBits, access, memory:{base,index,scale,displacement:BigInt(displacement),segment,addressSizeBits} }; }
export function decoded({ family,operands=[],address=0x401000n,length=4,bytes=null,prefixes=[],addressSizeBits=64,implicitReads=[],implicitWrites=[],conditionCode=null,detailAvailable=true,mnemonic='',opStr='' }={}) {
  sequence += 1;
  return createX86DecodedInstruction({ instructionId:`p5-2:test:${sequence}:${family}`, instructionCode:1000+sequence, instructionFamily:family, address, length, rawBytes:Uint8Array.from(bytes ?? Array.from({length},()=>0x90)), mode:'long-64', mnemonic, opStr, detailAvailable, detailStatus:detailAvailable?'complete':'unavailable', detail:{ addressSizeBits, prefixes:{legacy:Uint8Array.from(prefixes),rex:null,vector:null}, operands, operandCount:operands.length, implicitReads, implicitWrites, conditionCode } });
}
export function operations(bundle,kind){return bundle.operations.filter((operation)=>operation.kind===kind);}
export function operation(bundle,kind,index=0){return operations(bundle,kind)[index]??null;}
export function independentEffectiveAddress({baseValue=null,indexValue=null,scale=1,displacement=0n,addressSizeBits=64,rip=null,instructionAddress=0n,instructionLength=0}) {
  const width=BigInt(addressSizeBits),mask=(1n<<width)-1n; let value=0n;
  if(rip!=null)value=(BigInt(instructionAddress)+BigInt(instructionLength))&((1n<<64n)-1n); else if(baseValue!=null)value=BigInt(baseValue)&mask;
  if(indexValue!=null)value=(value+((BigInt(indexValue)&mask)*BigInt(scale)))&mask;
  value=(value+BigInt(displacement))&mask; return addressSizeBits===32?value&0xffffffffn:value&((1n<<64n)-1n);
}
function valueOf(value){if(!value||value.value==null)throw new TypeError('test-value-required');return BigInt(value.value);}
function makeValue(widthBits,value){const mask=(1n<<BigInt(widthBits))-1n;return{widthBits,value:BigInt(value)&mask};}
export function evaluateMaterializedAddress(materialize,instruction,operand,registerValues={}) {
  const ctx={instruction,constant(widthBits,value){return makeValue(widthBits,value);},readRegister(registerOperand){const id=registerOperand?.register?.id,physical=registerOperand?.register?.physicalId,raw=registerValues[id]??registerValues[physical];return raw==null?null:makeValue(registerOperand.widthBits,raw);},valueOp(opcode,inputs,widthBits){const mask=(1n<<BigInt(widthBits))-1n;if(opcode==='add')return makeValue(widthBits,(valueOf(inputs[0])+valueOf(inputs[1]))&mask);if(opcode==='sub')return makeValue(widthBits,(valueOf(inputs[0])-valueOf(inputs[1]))&mask);if(opcode==='shl')return makeValue(widthBits,(valueOf(inputs[0])<<valueOf(inputs[1]))&mask);throw new TypeError(`unsupported-test-opcode:${opcode}`);},coerce(value,fromBits,toBits){return makeValue(toBits,valueOf(value));}};
  const result=materialize(ctx,operand);return result==null?null:valueOf(result);
}
