import { createX86EffectContext, x86MemoryFaults, x86RegisterOperand } from './common.js';
import { x86EffectiveAddressExpression } from './addressing.js';

const FULL_MOVES = new Map([['movaps',true],['movups',false],['movapd',true],['movupd',false],['movdqa',true],['movdqu',false]]);
const INTEGER_MOVES = new Map([['movd',32],['movq',64]]);
const BITWISE = new Map([['andps','and'],['andpd','and'],['pand','and'],['orps','or'],['orpd','or'],['por','or'],['xorps','xor'],['xorpd','xor'],['pxor','xor']]);
const PACKED_ARITHMETIC = new Map([['paddb',['add',8]],['paddw',['add',16]],['paddd',['add',32]],['paddq',['add',64]],['psubb',['sub',8]],['psubw',['sub',16]],['psubd',['sub',32]],['psubq',['sub',64]]]);
const PACKED_COMPARE = new Map([['pcmpeqb',['eq',8,'bitwise-equality']],['pcmpeqw',['eq',16,'bitwise-equality']],['pcmpeqd',['eq',32,'bitwise-equality']],['pcmpgtb',['gt',8,'signed']],['pcmpgtw',['gt',16,'signed']],['pcmpgtd',['gt',32,'signed']]]);
const PACKED_SHIFT = new Map([['psllw',['left',false,16]],['pslld',['left',false,32]],['psllq',['left',false,64]],['psrlw',['right',false,16]],['psrld',['right',false,32]],['psrlq',['right',false,64]],['psraw',['right',true,16]],['psrad',['right',true,32]]]);

function baseFamily(family){return family.startsWith('v')?family.slice(1):family;}
function isVector(operand){return operand?.type==='register'&&operand.register?.kind==='vector';}
function physicalId(operand){return isVector(operand)?operand.register.physicalId:null;}
function unique(values){return [...new Set(values.filter(Boolean))].sort();}

export function x86VectorEncodingInfo(instruction){
  const vector=instruction?.detail?.prefixes?.vector??null;
  if(vector==null)return Object.freeze({kind:'legacy',prefixKind:null,vectorWidthBits:128,valid:true});
  const kind=String(vector.kind||'').toLowerCase(),bytes=Uint8Array.from(vector.bytes||[]);
  if(kind==='evex')return Object.freeze({kind:'evex',prefixKind:'evex',vectorWidthBits:null,valid:bytes.length===4&&bytes[0]===0x62});
  if(kind==='vex2'&&bytes.length===2&&bytes[0]===0xc5)return Object.freeze({kind:'vex',prefixKind:'vex2',vectorWidthBits:(bytes[1]&4)?256:128,valid:true});
  if(kind==='vex3'&&bytes.length===3&&bytes[0]===0xc4)return Object.freeze({kind:'vex',prefixKind:'vex3',vectorWidthBits:(bytes[2]&4)?256:128,valid:true});
  return Object.freeze({kind:'invalid',prefixKind:kind||null,vectorWidthBits:null,valid:false});
}

function validateEncoding(ctx,family,scalar=false){
  const encoding=x86VectorEncodingInfo(ctx.instruction);
  if(!encoding.valid)return{error:ctx.partial('x86-vector-prefix-metadata-malformed',['registers','other'],{metadata:{operation:family,vectorPrefixKind:encoding.prefixKind}})};
  if(encoding.kind==='evex')return{error:ctx.partial('x86-evex-physical-state-unmodelled',['registers','other'],{metadata:{operation:family,vectorPrefixKind:'evex'}})};
  if(family.startsWith('v')!==(encoding.kind==='vex'))return{error:ctx.partial('x86-vector-family-encoding-mismatch',['registers','other'],{metadata:{operation:family,encodingKind:encoding.kind}})};
  if(scalar&&encoding.kind==='vex'&&encoding.vectorWidthBits!==128)return{error:ctx.partial('x86-vex-scalar-width-not-proven',['registers','other'],{metadata:{operation:family,encodedVectorWidthBits:encoding.vectorWidthBits}})};
  return{encoding};
}

function memoryAddress(ctx,operand){const memory=operand?.type==='memory'?operand.memory:null;if(!memory||memory.addressSizeBits!==64||memory.segment!=null)return null;return x86EffectiveAddressExpression(ctx.instruction,operand);}

export function readX86VectorOperand(ctx,operand,widthBits,config={}){
  if(isVector(operand)){if(operand.widthBits!==widthBits)return null;const value=ctx.readRegister(operand);return value?{value,registerId:physicalId(operand),possibleFaults:[]}:null;}
  if(operand?.type!=='memory'||operand.widthBits!==widthBits)return null;const address=memoryAddress(ctx,operand);if(!address)return null;
  const value=ctx.readMemory(address.expression,widthBits,{space:address.space,...(config.alignment?{alignment:config.alignment}:{}),metadata:{...address.metadata,vectorAccess:true}});
  return{value,registerId:null,possibleFaults:x86MemoryFaults('read',widthBits),address};
}

export function writeX86VectorRegister(ctx,destination,value,encoding,widthBits){
  if(!isVector(destination)||destination.widthBits!==widthBits)return false;const physical=x86RegisterOperand(destination.register.physicalId);if(!physical)return false;
  if(widthBits===256)return encoding.kind==='vex'&&ctx.writeRegister(physical,value);if(widthBits!==128)return false;
  if(encoding.kind==='legacy'){const old=ctx.readRegister(physical);if(!old)return false;const merged=ctx.valueOp('insert',[old,value],256,{lsb:0,widthBits:128,physicalBits:256,physicalId:physical.id,view:destination.register.id,writePolicy:'legacy-preserve-upper-128'});return ctx.writeRegister(physical,merged);}
  if(encoding.kind==='vex')return ctx.writeRegister(physical,ctx.coerce(value,128,256,false));return false;
}

function vectorWidth(ctx,encoding,allow256=true){const widths=ctx.operands.map((operand)=>Number(operand?.widthBits||0)).filter((width)=>width===128||width===256),width=widths[0]??null;if(!width||(!allow256&&width!==128)||(encoding.kind==='legacy'&&width!==128)||(encoding.kind==='vex'&&encoding.vectorWidthBits!==width))return null;return width;}
function upperBehavior(encoding,width){return width===256?'replace-ymm':encoding.kind==='vex'?'zero-upper-128':'preserve-upper-128';}
function mergeFaults(...groups){return groups.flat().filter(Boolean);}
function alignmentFault(width,family){return{kind:'alignment-fault',condition:{kind:'x86-simd-required-alignment',alignmentBytes:width/8},detail:{operation:family,widthBits:width,fault:'#GP',independentOfAlignmentCheckFlag:true}};}
function integrationPartial(ctx,family){return ctx.partial('x86-simd-memory-address-requires-p5-2-integration',['memory','registers'],{metadata:{family:'simd',operation:family,classification:'P5-I-INTEGRATION-REQUIRED'}});}

function binaryOperands(ctx,encoding,width){const[destination,a,b]=ctx.operands,leftRaw=encoding.kind==='legacy'?destination:a,rightRaw=encoding.kind==='legacy'?a:b;if(!isVector(destination)||!isVector(leftRaw))return null;const left=readX86VectorOperand(ctx,leftRaw,width),right=readX86VectorOperand(ctx,rightRaw,width);if(!left||!right)return null;return{destination,left,right,registersRead:unique([left.registerId,right.registerId]),faults:mergeFaults(left.possibleFaults,right.possibleFaults)};}

function lowScalar(ctx,operand,width){
  if(isVector(operand)){if(operand.widthBits!==128)return null;const value=ctx.readRegister(operand);return value?{value:ctx.valueOp('extract',[value],width,{lsb:0,widthBits:width,scalarIntegerMove:true}),possibleFaults:[]}:null;}
  if(operand?.type==='register'&&operand.register?.kind!=='vector'&&operand.widthBits===width){const value=ctx.readRegister(operand);return value?{value,possibleFaults:[]}:null;}
  if(operand?.type==='memory'&&operand.widthBits===width){const address=memoryAddress(ctx,operand);if(!address)return{integrationRequired:true};return{value:ctx.readMemory(address.expression,width,{space:address.space,metadata:{...address.metadata,scalarIntegerMove:true}}),possibleFaults:x86MemoryFaults('read',width)};}
  return null;
}

function liftIntegerMove(ctx,family,encoding,width){
  if(encoding.kind==='vex'&&encoding.vectorWidthBits!==128)return ctx.partial(`x86-${family}-vex-width-unmodelled`,['registers','memory','other']);const[destination,source]=ctx.operands;
  if(isVector(destination)){const input=lowScalar(ctx,source,width);if(input?.integrationRequired)return integrationPartial(ctx,family);if(!input)return ctx.partial(`x86-${family}-source-unmodelled`,['registers','memory']);const low128=ctx.coerce(input.value,width,128,false);if(!writeX86VectorRegister(ctx,destination,low128,encoding,128))return ctx.partial(`x86-${family}-vector-write-unmodelled`,['registers']);return ctx.finish({family:'simd',possibleFaults:input.possibleFaults,metadata:{operation:family,scalarWidthBits:width,xmmBitsAboveScalar:'zero',upperLaneBehavior:upperBehavior(encoding,128)}});}
  if(!isVector(source))return ctx.partial(`x86-${family}-operand-shape-unmodelled`,['registers','memory']);const input=lowScalar(ctx,source,width);if(!input)return ctx.partial(`x86-${family}-source-unmodelled`,['registers']);
  if(destination?.type==='register'&&destination.register?.kind!=='vector'&&destination.widthBits===width){if(!ctx.writeRegister(destination,input.value))return ctx.partial(`x86-${family}-gp-write-unmodelled`,['registers']);return ctx.finish({family:'simd',metadata:{operation:family,scalarWidthBits:width,destination:'gp-register',upperVectorState:'unchanged'}});}
  if(destination?.type==='memory'&&destination.widthBits===width){const address=memoryAddress(ctx,destination);if(!address)return integrationPartial(ctx,family);ctx.writeMemory(address.expression,width,input.value,{space:address.space,metadata:{...address.metadata,scalarIntegerMove:true}});return ctx.finish({family:'simd',possibleFaults:x86MemoryFaults('write',width),metadata:{operation:family,scalarWidthBits:width,destination:'memory',memoryWidthBits:width,upperVectorState:'unchanged'}});}
  return ctx.partial(`x86-${family}-operand-shape-unmodelled`,['registers','memory']);
}

function liftFullMove(ctx,family,encoding,aligned){
  const width=vectorWidth(ctx,encoding,true);if(!width)return ctx.partial('x86-vector-width-unmodelled',['registers','memory','other'],{metadata:{operation:family}});const[destination,source]=ctx.operands,alignment=aligned?width/8:null,extra=aligned?[alignmentFault(width,family)]:[];
  if(isVector(destination)){const input=readX86VectorOperand(ctx,source,width,{alignment});if(!input)return source?.type==='memory'?integrationPartial(ctx,family):ctx.partial(`x86-${family}-source-unmodelled`,['registers','memory']);if(!writeX86VectorRegister(ctx,destination,input.value,encoding,width))return ctx.partial(`x86-${family}-destination-unmodelled`,['registers']);return ctx.finish({family:'simd',possibleFaults:mergeFaults(input.possibleFaults,source?.type==='memory'?extra:[]),metadata:{operation:family,vectorWidthBits:width,aligned,memoryWidthBits:source?.type==='memory'?source.widthBits:null,encodingKind:encoding.kind,upperLaneBehavior:upperBehavior(encoding,width)}});}
  if(destination?.type==='memory'&&isVector(source)&&destination.widthBits===width&&source.widthBits===width){const address=memoryAddress(ctx,destination);if(!address)return integrationPartial(ctx,family);const value=ctx.readRegister(source);if(!value)return ctx.partial(`x86-${family}-source-unmodelled`,['registers']);ctx.writeMemory(address.expression,width,value,{space:address.space,...(alignment?{alignment}:{}),metadata:{...address.metadata,vectorAccess:true}});return ctx.finish({family:'simd',possibleFaults:mergeFaults(x86MemoryFaults('write',width),extra),metadata:{operation:family,vectorWidthBits:width,aligned,memoryWidthBits:width,destinationState:'memory-only'}});}
  return ctx.partial(`x86-${family}-operand-shape-unmodelled`,['registers','memory']);
}

function packedIntrinsic(ctx,family,encoding,spec,comparison=false){
  const width=vectorWidth(ctx,encoding,false);if(!width)return ctx.partial('x86-vector-width-unmodelled',['registers','memory','other'],{metadata:{operation:family}});const operands=binaryOperands(ctx,encoding,width);if(!operands)return ctx.partial(`x86-${family}-operand-shape-unmodelled`,['registers','memory']);const[operation,elementWidth,signedness='modular-wrap']=spec;
  const out=ctx.intrinsic('x86.simd.packed-integer',[operands.left.value,operands.right.value],[width],{registersRead:operands.registersRead,registersWritten:[operands.destination.register.physicalId],determinism:'input-dependent',symbolicDetail:'summary-only',metadata:{operation:comparison?'compare':operation,relation:comparison?operation:null,vectorWidthBits:width,elementWidthBits:elementWidth,laneCount:width/elementWidth,signedness,encodingKind:encoding.kind,upperLaneBehavior:upperBehavior(encoding,width),trueLaneValue:comparison?'all-ones':null,falseLaneValue:comparison?'zero':null,overflow:comparison?null:'wrap-mod-2^elementWidth',exactArchitecturalSummary:true}})[0];
  if(!writeX86VectorRegister(ctx,operands.destination,out,encoding,width))return ctx.partial(`x86-${family}-destination-unmodelled`,['registers']);return ctx.finish({family:'simd',possibleFaults:operands.faults,metadata:{operation:family,vectorWidthBits:width,elementWidthBits:elementWidth,laneCount:width/elementWidth,signedness,encodingKind:encoding.kind}});
}

function liftShift(ctx,family,encoding,spec){
  const width=vectorWidth(ctx,encoding,false);if(!width)return ctx.partial('x86-vector-width-unmodelled',['registers','memory','other'],{metadata:{operation:family}});const[direction,arithmetic,elementWidth]=spec,destination=ctx.operands[0],source=encoding.kind==='legacy'?destination:ctx.operands[1],count=encoding.kind==='legacy'?ctx.operands[1]:ctx.operands[2];if(!isVector(destination)||!isVector(source)||count?.type!=='immediate')return ctx.partial(`x86-${family}-operand-shape-unmodelled`,['registers','other']);const sourceValue=ctx.readRegister(source);if(!sourceValue)return ctx.partial(`x86-${family}-source-unmodelled`,['registers']);const countValue=ctx.constant(8,count.value);
  const out=ctx.intrinsic('x86.simd.packed-shift',[sourceValue,countValue],[width],{registersRead:[source.register.physicalId],registersWritten:[destination.register.physicalId],determinism:'input-dependent',symbolicDetail:'summary-only',metadata:{operation:family,vectorWidthBits:width,elementWidthBits:elementWidth,laneCount:width/elementWidth,direction,arithmetic,countSource:'imm8',outOfRange:arithmetic?'sign-fill-after-saturating-count':'zero-lane-when-count-greater-or-equal-elementWidth',encodingKind:encoding.kind,upperLaneBehavior:upperBehavior(encoding,width),exactArchitecturalSummary:true}})[0];if(!writeX86VectorRegister(ctx,destination,out,encoding,width))return ctx.partial(`x86-${family}-destination-unmodelled`,['registers']);return ctx.finish({family:'simd',metadata:{operation:family,vectorWidthBits:width,elementWidthBits:elementWidth,countSource:'imm8'}});
}

function liftPshufd(ctx,family,encoding){
  const width=vectorWidth(ctx,encoding,false);if(!width)return ctx.partial('x86-vector-width-unmodelled',['registers','memory','other'],{metadata:{operation:family}});const[destination,source,mask]=ctx.operands;if(!isVector(destination)||mask?.type!=='immediate')return ctx.partial(`x86-${family}-operand-shape-unmodelled`,['registers','memory','other']);const input=readX86VectorOperand(ctx,source,128);if(!input)return ctx.partial(`x86-${family}-source-unmodelled`,['registers','memory']);const immediate=Number(BigInt.asUintN(8,mask.value)),laneMap=[0,1,2,3].map((lane)=>({destinationLane:lane,source:0,sourceLane:(immediate>>(lane*2))&3}));const out=ctx.intrinsic('x86.simd.shuffle',[input.value,ctx.constant(8,mask.value)],[128],{registersRead:unique([input.registerId]),registersWritten:[destination.register.physicalId],determinism:'input-dependent',symbolicDetail:'summary-only',metadata:{operation:'pshufd',vectorWidthBits:128,elementWidthBits:32,laneCount:4,immediate,laneMap,encodingKind:encoding.kind,upperLaneBehavior:upperBehavior(encoding,128),exactArchitecturalSummary:true}})[0];if(!writeX86VectorRegister(ctx,destination,out,encoding,128))return ctx.partial(`x86-${family}-destination-unmodelled`,['registers']);return ctx.finish({family:'simd',possibleFaults:input.possibleFaults,metadata:{operation:family,vectorWidthBits:128,laneMap}});
}

function liftPunpckldq(ctx,family,encoding){
  const width=vectorWidth(ctx,encoding,false);if(!width)return ctx.partial('x86-vector-width-unmodelled',['registers','memory','other'],{metadata:{operation:family}});const operands=binaryOperands(ctx,encoding,128);if(!operands)return ctx.partial(`x86-${family}-operand-shape-unmodelled`,['registers','memory']);const laneMap=[[0,0],[1,0],[0,1],[1,1]].map(([source,sourceLane],destinationLane)=>({destinationLane,source,sourceLane}));const out=ctx.intrinsic('x86.simd.unpack',[operands.left.value,operands.right.value],[128],{registersRead:operands.registersRead,registersWritten:[operands.destination.register.physicalId],determinism:'input-dependent',symbolicDetail:'summary-only',metadata:{operation:'punpckldq',vectorWidthBits:128,elementWidthBits:32,laneCount:4,half:'low',laneMap,encodingKind:encoding.kind,upperLaneBehavior:upperBehavior(encoding,128),exactArchitecturalSummary:true}})[0];if(!writeX86VectorRegister(ctx,operands.destination,out,encoding,128))return ctx.partial(`x86-${family}-destination-unmodelled`,['registers']);return ctx.finish({family:'simd',possibleFaults:operands.faults,metadata:{operation:family,vectorWidthBits:128,laneMap}});
}

export function liftX86SimdEffects(instruction,context={}){
  const family=String(instruction?.instructionFamily||'').toLowerCase(),base=baseFamily(family),rawVector=instruction?.detail?.prefixes?.vector;
  if(String(rawVector?.kind||'').toLowerCase()==='evex'){const ctx=createX86EffectContext(instruction,context);return ctx.partial('x86-evex-physical-state-unmodelled',['registers','other'],{metadata:{family:'simd',operation:family,vectorPrefixKind:'evex'}});}
  const recognized=FULL_MOVES.has(base)||INTEGER_MOVES.has(base)||BITWISE.has(base)||PACKED_ARITHMETIC.has(base)||PACKED_COMPARE.has(base)||PACKED_SHIFT.has(base)||base==='pshufd'||base==='punpckldq'||['vzeroupper','vzeroall','emms'].includes(family);if(!recognized)return null;const ctx=createX86EffectContext(instruction,context);
  if(family==='emms')return ctx.partial('x86-mmx-x87-alias-state-unmodelled',['registers','other'],{metadata:{family:'simd',operation:'emms',mmxIndependentStateInvented:false}});if(family==='vzeroall')return ctx.partial('x86-vzeroall-full-vector-state-unmodelled',['registers','other'],{metadata:{family:'simd',operation:'vzeroall',unsupportedState:['zmm','xmm16-31','ymm16-31']}});
  if(family==='vzeroupper'){const check=validateEncoding(ctx,family);if(check.error)return check.error;if(check.encoding.kind!=='vex'||check.encoding.vectorWidthBits!==128)return ctx.partial('x86-vzeroupper-encoding-unmodelled',['registers','other']);for(let index=0;index<16;index+=1){const physical=x86RegisterOperand(`ymm${index}`),old=ctx.readRegister(physical);if(!old)return ctx.partial('x86-vzeroupper-register-state-unmodelled',['registers']);const low=ctx.valueOp('extract',[old],128,{lsb:0,widthBits:128,physicalBits:256,physicalId:`ymm${index}`,view:`xmm${index}`});if(!ctx.writeRegister(physical,ctx.coerce(low,128,256,false)))return ctx.partial('x86-vzeroupper-register-write-unmodelled',['registers']);}return ctx.finish({family:'simd',metadata:{operation:'vzeroupper',registers:['ymm0-ymm15'],low128:'preserved',upper128:'zeroed',unsupportedStateTouched:false}});}
  const check=validateEncoding(ctx,family,INTEGER_MOVES.has(base));if(check.error)return check.error;const encoding=check.encoding;
  if(INTEGER_MOVES.has(base))return liftIntegerMove(ctx,family,encoding,INTEGER_MOVES.get(base));if(FULL_MOVES.has(base))return liftFullMove(ctx,family,encoding,FULL_MOVES.get(base));
  if(BITWISE.has(base)){const width=vectorWidth(ctx,encoding,true);if(!width)return ctx.partial(encoding.kind==='vex'?'x86-vex-width-operand-mismatch':'x86-vector-width-unmodelled',['registers','memory','other'],{metadata:{operation:family}});const operands=binaryOperands(ctx,encoding,width);if(!operands)return ctx.partial(`x86-${family}-operand-shape-unmodelled`,['registers','memory']);const result=ctx.valueOp(BITWISE.get(base),[operands.left.value,operands.right.value],width,{vectorBitwise:true,vectorWidthBits:width,semanticFamily:base});if(!writeX86VectorRegister(ctx,operands.destination,result,encoding,width))return ctx.partial(`x86-${family}-destination-unmodelled`,['registers']);return ctx.finish({family:'simd',possibleFaults:operands.faults,metadata:{operation:family,vectorWidthBits:width,bitwiseOperation:BITWISE.get(base),encodingKind:encoding.kind,upperLaneBehavior:upperBehavior(encoding,width)}});}
  if(PACKED_ARITHMETIC.has(base))return packedIntrinsic(ctx,family,encoding,PACKED_ARITHMETIC.get(base),false);if(PACKED_COMPARE.has(base))return packedIntrinsic(ctx,family,encoding,PACKED_COMPARE.get(base),true);if(PACKED_SHIFT.has(base))return liftShift(ctx,family,encoding,PACKED_SHIFT.get(base));if(base==='pshufd')return liftPshufd(ctx,family,encoding);if(base==='punpckldq')return liftPunpckldq(ctx,family,encoding);return null;
}
