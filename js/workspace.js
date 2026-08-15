import { Backend } from './backend.js';
import { SymbolIndex } from './symbols.js';
import { createHexProject, exportHexProject, importHexProject, serializeHexProject, parseHexProject } from './project/index.js';
import { diffFunctions } from './diff/index.js';

const LOCAL_PREFIX='hex.project.v1.';
const MAX_PROJECT_AI_TURNS=200;
const MAX_PROJECT_FINDINGS=1000;
const MAX_DIFF_FUNCTIONS=350000;

function keyOf(value){return value==null?'':String(value);}
function cleanName(name){return String(name||'analysis').replace(/[^a-z0-9._-]+/gi,'_').replace(/^_+|_+$/g,'').slice(0,120)||'analysis';}
function asBigInt(value){try{return value==null?null:BigInt(value);}catch{return null;}}
function bytesOf(value){return Array.from(value||[],(x)=>Number(x)&255);}
function identityKey(identity){
  const meta=identity?.metadata||{};
  return [identity?.hash||'',meta.sliceIndex,meta.sliceOffset,meta.sliceSize,meta.uuid,meta.architecture].map(keyOf).join('\0');
}
function staleWorkspaceError(){const error=new Error('workspace-binding-changed');error.code='HEX_WORKSPACE_STALE';return error;}

export function binaryIdentity(app, hash=null){
  const info=app?.store?.get?.('fileInfo')||null;
  const index=app?.store?.get?.('sliceIndex')??-1;
  const slice=index>=0?info?.slices?.[index]||null:null;
  const meta=slice?.info||{};
  return {
    hash:hash||app?.backend?.contentHash||null,
    metadata:{
      name:info?.name||app?.store?.get?.('file')?.name||null,
      size:info?.size??app?.store?.get?.('file')?.size??null,
      format:info?.format||app?.backend?.formatId||null,
      sliceIndex:index,
      sliceOffset:slice?.offset??null,
      sliceSize:slice?.size??null,
      uuid:meta.uuid||null,
      architecture:app?.store?.get?.('architecture')||meta.architecture||meta.cpu||null,
    },
  };
}

export function sameProjectIdentity(project, identity){
  if(!project?.binary?.hash||!identity?.hash||project.binary.hash!==identity.hash)return {ok:false,reason:'binary-hash-mismatch'};
  const a=project.binary.metadata||{}, b=identity.metadata||{};
  const keys=['sliceIndex','sliceOffset','sliceSize','uuid','architecture'];
  for(const key of keys){
    if(a[key]==null||b[key]==null)continue;
    if(keyOf(a[key])!==keyOf(b[key]))return {ok:false,reason:'slice-identity-mismatch',field:key};
  }
  return {ok:true};
}

function noteEntries(map){
  const out=[];
  for(const [address,value] of map||[])out.push({address:asBigInt(address),value});
  return out.filter((x)=>x.address!=null);
}
function patchEntries(patches){
  return (patches?.list?.()||[]).map((p)=>({
    offset:p.offset,before:bytesOf(p.before),after:bytesOf(p.after),
    addr:p.addr??null,label:p.label??null,reason:p.reason??null,
  }));
}
function safeFindings(app){
  const report=app?.autoReport?.report||null;
  if(!report)return [];
  return (report.confirmed||report.settled||report.pinned||[]).slice(0,MAX_PROJECT_FINDINGS);
}
function safeEvidence(app){
  const report=app?.autoReport?.report||null;
  return (report?.deep||[]).slice(0,MAX_PROJECT_FINDINGS);
}
function aiTurns(){
  const session=globalThis.window?.__hexAi?.session||globalThis.window?.__hexUi?.assistant?.session||null;
  return Array.isArray(session?.turns)?session.turns.slice(-MAX_PROJECT_AI_TURNS).map((t)=>({
    role:t.role,status:t.status||null,text:t.text||t.response?.answerText||'',mode:t.mode||null,scope:t.scope||null,at:t.at||null,
  })):[];
}

export function snapshotWorkspace(app, identity){
  const notes=app.notes;
  const navigation=app.navigation;
  const project=createHexProject({
    binary:identity,
    userNames:noteEntries(notes?.names),
    comments:noteEntries(notes?.comments),
    types:[...((notes?.types)||[])].map(([key,value])=>({key,value})),
    structs:Array.isArray(notes?.structs)?notes.structs:[],
    bookmarks:(navigation?.entries||[]).slice(-500),
    patches:patchEntries(app.patches),
    confirmedFindings:safeFindings(app),
    evidence:safeEvidence(app),
    investigationSessions:aiTurns().length?[{turns:aiTurns()}]:[],
    agentAnswers:aiTurns().filter((t)=>t.role==='assistant'&&t.status==='done'),
    analysisSettings:{ language:app?.prefs?.lang||null, explain:app?.prefs?.explain??null, textSize:app?.prefs?.textSize||null },
    navigation:{
      currentFunction:app?.store?.get?.('currentAddress')??null,
      history:(navigation?.entries||[]).slice(-500),
      bookmarks:(navigation?.entries||[]).slice(-100),
      lastQuery:app?.lastGoal?.text||null,
    },
  });
  project.compare=app?.workspace?.diffState?.provenance||null;
  return project;
}

export function applyWorkspaceProject(app, project){
  const notes=app.notes;
  if(!notes||!notes.id)throw new Error('notes-unavailable');
  notes.names.clear();notes.comments.clear();notes.types.clear();notes.vars.clear();
  for(const entry of project.user.names||[])if(entry?.address!=null&&entry.value)notes.names.set(BigInt(entry.address).toString(),String(entry.value));
  for(const entry of project.user.comments||[])if(entry?.address!=null&&entry.value)notes.comments.set(BigInt(entry.address).toString(),String(entry.value));
  for(const entry of project.user.types||[])if(entry?.key)notes.types.set(String(entry.key),String(entry.value||''));
  notes.structs=Array.isArray(project.user.structs)?project.user.structs.slice():[];
  notes.dirty=true;
  if(!notes.save())throw new Error(notes.lastSaveError?.code||'notes-save-failed');
  app.patches.clear();
  for(const p of project.user.patches||[]){
    if(p?.offset==null)continue;
    app.patches.add(BigInt(p.offset),p.before||[],p.after||[],{addr:p.addr??null,label:p.label??null,reason:p.reason??null});
  }
  if(app.symbols){for(const entry of notes.nameEntries())app.symbols.rename(entry.addr,entry.name);app.viewer?.setSymbols?.(app.symbols);}
  if(project.findings?.confirmed?.length||project.findings?.evidence?.length){
    app.autoReport={
      report:{confirmed:project.findings.confirmed||[],settled:project.findings.confirmed||[],deep:project.findings.evidence||[],pinned:project.findings.confirmed||[],notes:['restored-project']},
      key:app.codeRegion?.()?.id||null,gen:app.symbols?.gen||0,restored:true,
    };
  }
  const history=project.navigation?.history||[];
  if(app.navigation&&history.length){app.navigation.entries=history.slice(-app.navigation.limit);app.navigation.index=app.navigation.entries.length-1;app.navigation.onChange(app.navigation.snapshot());}
  return true;
}

function functionsFromSymbols(symbols,limit=MAX_DIFF_FUNCTIONS){
  const funcs=symbols?.funcs||[];const out=[];const n=Math.min(funcs.length,limit);
  for(let i=0;i<n;i++){
    const address=funcs[i], next=i+1<funcs.length?funcs[i+1]:null;
    out.push({address,name:symbols.nameAt?.(address)||null,size:next!=null&&next>address?Number(next-address):0,strings:[],calls:[],imports:[],semantic:{writes:[],thresholds:[]},fieldAccessShape:[]});
  }
  out.complete=n===funcs.length && symbols?.functionStartsComplete===true;
  out.total=funcs.length;out.scanned=n;out.truncationReason=n<funcs.length?'function-budget':symbols?.functionStartsComplete===true?null:'function-discovery-incomplete';
  return out;
}

function currentDiffFunctions(app){
  const records=app?.recognition?.records||[];
  if(records.length){
    const out=records.slice(0,MAX_DIFF_FUNCTIONS).map((x)=>x.fingerprint||{address:x.address,name:x.name||x.originalName||null,size:0,semantic:{},strings:[],calls:[],imports:[]});
    out.complete=app.recognition.complete===true&&records.length<=MAX_DIFF_FUNCTIONS;out.total=app.recognition.total||records.length;out.scanned=out.length;out.truncationReason=out.complete?null:(app.recognition.truncationReason||'function-budget');return out;
  }
  return functionsFromSymbols(app?.symbols);
}

function chooseSlice(info,architecture){
  const slices=info?.slices||[];
  let index=architecture?slices.findIndex((x)=>x?.capability?.architecture===architecture||x?.info?.architecture===architecture||x?.info?.cpu===architecture):-1;
  if(index<0)index=slices.findIndex((x)=>x?.info?.isArm64);
  if(index<0)index=slices.findIndex((x)=>x?.info);
  return index;
}

export class ProductWorkspace{
  constructor(app,{backendFactory=()=>new Backend(),storage=globalThis.localStorage}={}){
    this.app=app;this.backendFactory=backendFactory;this.storage=storage||null;this.project=null;this.identity=null;this.baseline=null;this.diffState=null;this.busy=null;
    this.bindingRevision=0;this.bindSequence=0;this.baselineSequence=0;
  }
  _resetBoundState(){const previous=this.baseline;this.bindingRevision++;this.baselineSequence++;this.project=null;this.baseline=null;this.diffState=null;this.busy=null;if(previous?.ownedBackend)previous.backend?.dispose?.();}
  _assertBinding(revision){if(revision!==this.bindingRevision)throw staleWorkspaceError();}
  async bind(){
    const sequence=++this.bindSequence;
    const sourceInfo=this.app?.store?.get?.('fileInfo')||null;
    if(!sourceInfo){this.identity=null;this._resetBoundState();return null;}
    const sourceSlice=this.app?.store?.get?.('sliceIndex')??-1;
    const sourceBackendGen=this.app?.backend?.gen;
    const hash=await this.app.backend.ensureContentHash();
    const superseded=sequence!==this.bindSequence || this.app?.store?.get?.('fileInfo')!==sourceInfo ||
      (this.app?.store?.get?.('sliceIndex')??-1)!==sourceSlice ||
      (sourceBackendGen!=null&&this.app?.backend?.gen!==sourceBackendGen);
    if(superseded){if(sequence===this.bindSequence){this.identity=null;this._resetBoundState();}return null;}
    const nextIdentity=binaryIdentity(this.app,hash);
    if(this.identity&&identityKey(this.identity)!==identityKey(nextIdentity))this._resetBoundState();
    this.identity=nextIdentity;
    const saved=this._loadLocal(this.identity);
    if(saved){const ok=sameProjectIdentity(saved,this.identity);if(ok.ok){try{applyWorkspaceProject(this.app,saved);this.project=saved;}catch{/* local restore is best effort */}}}
    if(!this.project)this.project=snapshotWorkspace(this.app,this.identity);
    return this.project;
  }
  snapshot(){if(!this.identity)return null;this.project=snapshotWorkspace(this.app,this.identity);return this.project;}
  autosave(){
    const project=this.snapshot();if(!project||!this.storage)return false;
    try{this.storage.setItem(this._localKey(this.identity),serializeHexProject(project));return true;}catch{return false;}
  }
  exportProject(){const project=this.snapshot();if(!project)throw new Error('project-unbound');return exportHexProject(project,cleanName(this.identity?.metadata?.name)+'.hexproj');}
  async importProject(input){
    if(!this.identity)await this.bind();
    const project=await importHexProject(input);const match=sameProjectIdentity(project,this.identity);
    if(!match.ok){const error=new Error(match.reason);error.code='HEX_PROJECT_BINARY_MISMATCH';error.detail=match;throw error;}
    applyWorkspaceProject(this.app,project);this.project=project;this.autosave();return project;
  }
  _localKey(identity){return LOCAL_PREFIX+identity.hash+':'+keyOf(identity.metadata?.sliceIndex)+':'+keyOf(identity.metadata?.uuid||identity.metadata?.architecture);}
  _loadLocal(identity){if(!this.storage)return null;try{const raw=this.storage.getItem(this._localKey(identity));return raw?parseHexProject(raw):null;}catch{return null;}}
  async loadBaseline(file,{backend=null}={}){
    if(!file)throw new Error('baseline-file-required');
    if(!this.identity)await this.bind();
    if(!this.identity)throw staleWorkspaceError();
    const revision=this.bindingRevision, request=++this.baselineSequence;
    const assertCurrent=()=>{this._assertBinding(revision);if(request!==this.baselineSequence)throw staleWorkspaceError();};
    const ownedBackend=!backend, other=backend||this.backendFactory();
    try{
      const info=await other.open(file);assertCurrent();
      const currentArch=this.identity?.metadata?.architecture||null;const sliceIndex=chooseSlice(info,currentArch);
      if(sliceIndex<0)throw new Error('baseline-slice-unavailable');
      const slice=info.slices[sliceIndex];const arch=slice?.capability?.architecture||slice?.info?.architecture||slice?.info?.cpu||null;
      if(currentArch&&arch&&currentArch!==arch){const error=new Error(`architecture mismatch: ${currentArch} vs ${arch}`);error.code='DIFF_ARCH_MISMATCH';throw error;}
      const hash=await other.ensureContentHash();assertCurrent();
      const result=await other.analyze(sliceIndex);assertCurrent();
      const symbols=new SymbolIndex({...result,regions:slice?.regions||[]});
      const functions=functionsFromSymbols(symbols);assertCurrent();
      const previous=this.baseline;
      this.baseline={file,backend:other,ownedBackend,info,sliceIndex,slice,architecture:arch,hash,symbols,functions,complete:functions.complete===true};
      if(previous?.ownedBackend&&previous.backend!==other)previous.backend?.dispose?.();
      this.diffState=null;return this.baseline;
    }catch(error){if(ownedBackend)other?.dispose?.();throw error;}
  }
  async diff(options={}){
    if(this.busy)return this.busy;
    const revision=this.bindingRevision;
    let task;
    task=(async()=>{
      if(!this.baseline)throw new Error('baseline-not-loaded');
      try{await this.app.ensureRecognition?.({maxFunctions:MAX_DIFF_FUNCTIONS,knowledgeLimit:0});}catch{/* symbol fallback remains valid */}
      this._assertBinding(revision);
      const current=currentDiffFunctions(this.app), before=this.baseline.functions;
      const result=diffFunctions(before,current,{mode:'fast',threshold:options.threshold??0.62,matchBudget:options.matchBudget||{maxCandidateEvaluations:1500000,maxEdges:300000,maxComponentNodes:4096,maxComponentEdges:65536}});
      this._assertBinding(revision);
      const inputsComplete=before.complete===true&&current.complete===true;
      result.completeness={complete:inputsComplete&&result.truncated!==true,reasons:[],baseline:{complete:before.complete===true,total:before.total,scanned:before.scanned,reason:before.truncationReason},current:{complete:current.complete===true,total:current.total,scanned:current.scanned,reason:current.truncationReason}};
      if(!before.complete)result.completeness.reasons.push('baseline-function-set-incomplete');
      if(!current.complete)result.completeness.reasons.push('current-function-set-incomplete');
      if(result.truncated)result.completeness.reasons.push('matcher-truncated');
      result.provenance={baselineHash:this.baseline.hash,currentHash:this.identity?.hash||null,architecture:this.baseline.architecture,currentArchitecture:this.identity?.metadata?.architecture||null,baselineName:this.baseline.info?.name||this.baseline.file?.name||null,currentName:this.identity?.metadata?.name||null,complete:result.completeness.complete};
      this._assertBinding(revision);
      this.diffState=result;return result;
    })().finally(()=>{if(this.busy===task)this.busy=null;});
    this.busy=task;return task;
  }
  getBinaryDiff(){return this.diffState;}
  dispose(){this.bindSequence++;this.identity=null;this._resetBoundState();}
}

export default ProductWorkspace;