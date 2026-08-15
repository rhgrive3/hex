const MAX_SAFE_BIGINT=BigInt(Number.MAX_SAFE_INTEGER);
export function checkedChunkIndex(value){
  const n=Number(value);
  if(!Number.isSafeInteger(n)||n<0) throw new RangeError('Chunk index must be a non-negative safe integer.');
  return n;
}
export function safeRegionLength(value,label='region size'){
  let n;
  try{n=BigInt(value);}catch{throw new RangeError(`${label} is invalid.`)}
  if(n<0n||n>MAX_SAFE_BIGINT) throw new RangeError(`${label} exceeds JavaScript safe integer range; refusing a lossy conversion.`);
  return Number(n);
}
export function utf8Len(buf,index){
  const c=buf[index];
  if(c<0x80) return (c>=0x20&&c<0x7f)||c===9||c===10?1:0;
  let need=0;
  if(c>=0xc2&&c<=0xdf) need=1;
  else if(c>=0xe0&&c<=0xef) need=2;
  else if(c>=0xf0&&c<=0xf4) need=3;
  else return 0;
  if(index+need>=buf.length) return -1;
  const b1=buf[index+1];
  if((b1&0xc0)!==0x80) return 0;
  // Reject overlong sequences, UTF-16 surrogate code points, and > U+10FFFF.
  if(c===0xe0&&b1<0xa0) return 0;
  if(c===0xed&&b1>0x9f) return 0;
  if(c===0xf0&&b1<0x90) return 0;
  if(c===0xf4&&b1>0x8f) return 0;
  for(let k=2;k<=need;k++) if((buf[index+k]&0xc0)!==0x80) return 0;
  return need+1;
}
export function isExactFunctionSeed(seed){
  if(!seed) return false;
  const sources=new Set([seed.source,...(seed.sources||[])]);
  return [...sources].some((s)=>['entrypoint','export','exception','unwind','function_starts','symbol','tls-callback','guard-cf'].includes(s)) && Number(seed.confidence??0)>=0.9;
}
