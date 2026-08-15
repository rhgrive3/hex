import fs from 'node:fs';

function replaceOnce(path, oldText, newText) {
  let source = fs.readFileSync(path, 'utf8');
  if (!source.includes(oldText)) throw new Error(`missing expected snippet in ${path}: ${oldText.slice(0, 120)}`);
  source = source.replace(oldText, newText);
  fs.writeFileSync(path, source);
}

// analyze.js: apply the requested row budget before fetching chunks, include a
// one-row sentinel so the 6000-instruction Semantic Model cap can report
// truncation, and make the cache budget-sensitive.
replaceOnce('js/analyze.js',
`const MAX_INSTRUCTIONS=40000;
const MAX_MODEL_ROWS=6000;
const CACHE_LIMIT=96;`,
`const MAX_INSTRUCTIONS=40000;
const MAX_MODEL_ROWS=6000;
const CACHE_LIMIT=96;
const ARM64_SEMANTIC_ARCHES=new Set(['arm64','arm64e','arm64_32']);

export function supportsArm64SemanticAnalysis(architecture){
  return ARM64_SEMANTIC_ARCHES.has(String(architecture||'').toLowerCase());
}
function rowBudget(opts={}){
  const raw=Number(opts?.maxRows);
  if(!Number.isFinite(raw))return MAX_INSTRUCTIONS;
  return Math.max(1,Math.min(MAX_INSTRUCTIONS,Math.floor(raw)));
}`);

replaceOnce('js/analyze.js',
`export async function analyzeFunction(backend,region,startRow,endRow,symbols,onProgress){
  const rows=Math.min(endRow-startRow+1,MAX_INSTRUCTIONS);
  const end=startRow+rows-1;`,
`export async function analyzeFunction(backend,region,startRow,endRow,symbols,onProgress,opts={}){
  const requestedRows=Math.max(0,endRow-startRow+1);
  const rows=Math.min(requestedRows,rowBudget(opts));
  if(rows<=0)throw new Error('analysis-range-empty');
  const end=startRow+rows-1;
  const truncated=requestedRows>rows;`);

replaceOnce('js/analyze.js',
`      if(mn && rawInsns.length<MAX_MODEL_ROWS)rawInsns.push({`,
`      // Keep one sentinel beyond the Semantic Model budget. buildSemanticModel
      // consumes only 6000 rows but needs raw.length > 6000 to prove truncation.
      if(mn && rawInsns.length<=MAX_MODEL_ROWS)rawInsns.push({`);

replaceOnce('js/analyze.js',
`  res.model=buildSemanticModel(rawInsns,{symbols,region,textRefs:texts});
  try{ annotateObjcCallsites(res.model,symbols); }catch{}
  return res;`,
`  res.model=buildSemanticModel(rawInsns,{symbols,region,textRefs:texts});
  if(truncated&&res.model)res.model.truncated=true;
  res.truncated=truncated||!!res.model?.truncated;
  res.requestedRows=requestedRows;
  res.analyzedRows=rows;
  try{ annotateObjcCallsites(res.model,symbols); }catch{}
  return res;`);

replaceOnce('js/analyze.js',
`export async function analyzeFunctionCached(backend,region,startRow,endRow,symbols,onProgress,opts={}){
  const symbolGen=symbols?.gen||0;
  const revision=analysisRevision(backend,region);
  const key=cacheKey(region,startRow,endRow,symbolGen,revision);`,
`export async function analyzeFunctionCached(backend,region,startRow,endRow,symbols,onProgress,opts={}){
  const symbolGen=symbols?.gen||0;
  const revision=analysisRevision(backend,region);
  const budget=rowBudget(opts);
  const key=cacheKey(region,startRow,endRow,symbolGen,revision)+':rows='+budget;`);

replaceOnce('js/analyze.js',
`  const promise=analyzeFunction(backend,region,startRow,endRow,symbols,onProgress)
    .then((res)=>{`,
`  const promise=analyzeFunction(backend,region,startRow,endRow,symbols,onProgress,{...opts,maxRows:budget})
    .then((res)=>{`);

// UI/AI adapter: honor explicit end and maxInstructions, fail closed when the
// function end is unproven, and never run the ARM64 semantic engine on x86/other
// architectures merely because Capstone can disassemble them.
replaceOnce('js/ai/ui/hex-context.js',
`import { analyzeFunctionCached } from '../../analyze.js';`,
`import { analyzeFunctionCached, supportsArm64SemanticAnalysis } from '../../analyze.js';`);

const oldAnalyzeModel = `export async function analyzeModelAt(app, address) {
  const addr = toBigInt(address);
  if (addr == null) return null;
  const region = regionForAddress(app, addr);
  if (!region || !app.store.get('canDisassemble')) return null;
  const sym = app.symbols;
  const fn = sym && sym.functionCount ? sym.functionAt(addr) : null;
  const start = fn ? fn.start : addr;
  if (!containsAddress(region, start)) return null;
  const step=BigInt(instructionBytes(app));
  if ((start-region.vmAddr)%step !== 0n) return null;
  const startRow = Number((start - region.vmAddr) / step);
  const totalRows = Number(region.size / step);
  const endRow = fn && fn.end != null
    ? Math.min(totalRows - 1, Number((fn.end - region.vmAddr) / step) - 1)
    : Math.min(totalRows - 1, startRow + 2048);
  if (endRow < startRow) return null;
  try {
    const res = await analyzeFunctionCached(app.backend, region, startRow, endRow, sym);
    return res && res.model ? res.model : null;
  } catch {
    return null;
  }
}`;
const newAnalyzeModel = `export async function analyzeModelAt(app, address, end = null, options = {}) {
  const addr = toBigInt(address);
  if (addr == null) return null;
  const architecture=app.store.get('architecture')||app.store.get('capability')?.architecture||null;
  if (!supportsArm64SemanticAnalysis(architecture)) return null;
  const region = regionForAddress(app, addr);
  if (!region || !app.store.get('canDisassemble')) return null;
  const sym = app.symbols;
  const fn = sym && sym.functionCount ? sym.functionAt(addr) : null;
  const start = fn ? fn.start : addr;
  if (!containsAddress(region, start)) return null;
  const step=BigInt(instructionBytes(app));
  if (step!==4n || (start-region.vmAddr)%step !== 0n) return null;
  const startRow = Number((start - region.vmAddr) / step);
  const totalRows = Number(region.size / step);
  const regionEnd=region.vmAddr+region.size;
  const provenEnd=fn?.end==null?null:toBigInt(fn.end);
  const requestedEnd=toBigInt(end);
  let boundedEnd=provenEnd;
  if(requestedEnd!=null)boundedEnd=boundedEnd==null?requestedEnd:(requestedEnd<boundedEnd?requestedEnd:boundedEnd);
  if(boundedEnd==null)boundedEnd=start+2048n*step;
  if(boundedEnd>regionEnd)boundedEnd=regionEnd;
  if(boundedEnd<=start)return null;
  const endRow=Math.min(totalRows-1,Number((boundedEnd-region.vmAddr+step-1n)/step)-1);
  if (endRow < startRow) return null;
  const rawMax=Number(options?.maxInstructions);
  if(Number.isFinite(rawMax)&&Math.floor(rawMax)<=0)return null;
  const maxRows=Number.isFinite(rawMax)?Math.max(1,Math.floor(rawMax)):undefined;
  const coversProvenEnd=provenEnd!=null&&provenEnd<=regionEnd&&boundedEnd>=provenEnd;
  try {
    const res = await analyzeFunctionCached(app.backend, region, startRow, endRow, sym, null, { maxRows });
    const model=res?.model;
    if(!model)return null;
    const incomplete=!coversProvenEnd||res.truncated===true||model.truncated===true;
    return incomplete&&model.truncated!==true?{...model,truncated:true}:model;
  } catch {
    return null;
  }
}`;
replaceOnce('js/ai/ui/hex-context.js', oldAnalyzeModel, newAnalyzeModel);

replaceOnce('js/ai/ui/hex-context.js',
`    analyze: (address) => analyzeModelAt(app, address),`,
`    analyze: (address, end, options) => analyzeModelAt(app, address, end, options),`);

// Product UI: generic Capstone support is not proof that the ARM64 semantic
// model can safely analyze the selected architecture.
replaceOnce('js/app.js',
`import { clearAnalysisCache, analyzeFunctionCached } from './analyze.js';`,
`import { clearAnalysisCache, analyzeFunctionCached, supportsArm64SemanticAnalysis } from './analyze.js';`);
replaceOnce('js/app.js',
`  async analyzeFunctionAt(addr) {
    const sym=this.symbols, range=this.validatedFunctionRange(addr);
    if(!range.ok || !this.store.get('canDisassemble') || !sym.functionCount) return null;`,
`  async analyzeFunctionAt(addr) {
    const sym=this.symbols, range=this.validatedFunctionRange(addr);
    const architecture=this.store.get('architecture')||this.store.get('capability')?.architecture||null;
    if(!supportsArm64SemanticAnalysis(architecture)||!range.ok||!this.store.get('canDisassemble')||!sym.functionCount)return null;`);

// Wire the regression into the normal AI gate.
{
  const path='package.json';
  const data=JSON.parse(fs.readFileSync(path,'utf8'));
  const parts=data.scripts['ai:test'].split('&&').map((item)=>item.trim());
  const command='node tests/ai-analysis-boundary.mjs';
  if(!parts.includes(command))parts.unshift(command);
  data.scripts['ai:test']=parts.join(' && ');
  fs.writeFileSync(path,JSON.stringify(data,null,2)+'\n');
}
