import fs from 'node:fs';

function replaceOnce(path, before, after) {
  const source = fs.readFileSync(path, 'utf8');
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`${path}: expected block not found`);
  if (source.indexOf(before, first + 1) >= 0) throw new Error(`${path}: expected block is not unique`);
  fs.writeFileSync(path, source.slice(0, first) + after + source.slice(first + before.length));
}

replaceOnce('js/workspace.js', `export function sameProjectIdentity(project, identity){
  if(!project?.binary?.hash||!identity?.hash||project.binary.hash!==identity.hash)return {ok:false,reason:'binary-hash-mismatch'};
  const a=project.binary.metadata||{}, b=identity.metadata||{};
  const keys=['sliceIndex','sliceOffset','sliceSize','uuid','architecture'];
  for(const key of keys){
    if(a[key]==null||b[key]==null)continue;
    if(keyOf(a[key])!==keyOf(b[key]))return {ok:false,reason:'slice-identity-mismatch',field:key};
  }
  return {ok:true};
}`,
`export function sameProjectIdentity(project, identity){
  if(!project?.binary?.hash||!identity?.hash||project.binary.hash!==identity.hash)return {ok:false,reason:'binary-hash-mismatch'};
  const a=project.binary.metadata||{}, b=identity.metadata||{};
  const keys=['sliceIndex','sliceOffset','sliceSize','uuid','architecture'];
  for(const key of keys){
    if(b[key]==null)continue;
    if(a[key]==null)return {ok:false,reason:'slice-identity-incomplete',field:key};
    if(keyOf(a[key])!==keyOf(b[key]))return {ok:false,reason:'slice-identity-mismatch',field:key};
  }
  return {ok:true};
}`);

replaceOnce('js/workspace.js', `  async importProject(input){
    if(!this.identity)await this.bind();
    const project=await importHexProject(input);const match=sameProjectIdentity(project,this.identity);
    if(!match.ok){const error=new Error(match.reason);error.code='HEX_PROJECT_BINARY_MISMATCH';error.detail=match;throw error;}
    applyWorkspaceProject(this.app,project);this.project=project;this.autosave();return project;
  }`,
`  async importProject(input){
    const liveHash=this.app?.backend?.contentHash||null;
    if(!this.identity||!liveHash||liveHash!==this.identity.hash)await this.bind();
    if(!this.identity)throw staleWorkspaceError();
    const revision=this.bindingRevision, boundKey=identityKey(this.identity);
    const sourceInfo=this.app?.store?.get?.('fileInfo')||null;
    const sourceSlice=this.app?.store?.get?.('sliceIndex')??-1;
    const sourceBackendGen=this.app?.backend?.gen;
    const assertCurrent=()=>{
      this._assertBinding(revision);
      const currentHash=this.app?.backend?.contentHash||null;
      if(identityKey(this.identity)!==boundKey || this.app?.store?.get?.('fileInfo')!==sourceInfo ||
        (this.app?.store?.get?.('sliceIndex')??-1)!==sourceSlice ||
        (sourceBackendGen!=null&&this.app?.backend?.gen!==sourceBackendGen) ||
        !currentHash || currentHash!==this.identity?.hash)throw staleWorkspaceError();
    };
    const project=await importHexProject(input);assertCurrent();
    const match=sameProjectIdentity(project,this.identity);
    if(!match.ok){const error=new Error(match.reason);error.code='HEX_PROJECT_BINARY_MISMATCH';error.detail=match;throw error;}
    applyWorkspaceProject(this.app,project);this.project=project;this.autosave();return project;
  }`);

replaceOnce('tests/review-cross-binary-state.mjs',
`import { ProductWorkspace } from '../js/workspace.js';
import { createAiEngine } from '../js/ai/ui/bridge.js';`,
`import { ProductWorkspace, sameProjectIdentity } from '../js/workspace.js';
import { createAiEngine } from '../js/ai/ui/bridge.js';
import { createHexProject, serializeHexProject } from '../js/project/index.js';`);

replaceOnce('tests/review-cross-binary-state.mjs',
`  const backend={contentHash:'hash-a',async ensureContentHash(){return this.contentHash;}};`,
`  const backend={gen:1,contentHash:'hash-a',async ensureContentHash(){return this.contentHash;}};`);

const marker = `// The real UI adapter must expose the live Backend/ProductWorkspace content hash
// as the strong identity used by TurnSnapshot/ObservationStore, not filename:slice.`;
const insertion = `// A project whose hash matches but whose slice identity is missing must not be
// accepted into a concrete active slice. Missing metadata is not proof of a match.
{
  const app=makeApp();
  const workspace=new ProductWorkspace(app,{storage:new Storage(),backendFactory:()=>({})});
  app.workspace=workspace;
  await workspace.bind();
  const match=sameProjectIdentity({binary:{hash:'hash-a',metadata:{}}},workspace.identity);
  assert.equal(match.ok,false);
  assert.equal(match.reason,'slice-identity-incomplete');
  assert.equal(match.field,'sliceIndex');
}

// Project parsing is asynchronous for Blob inputs. If the active file changes
// while text() is pending, the old project's notes must never land in the new
// file's NoteStore before workspace.bind() catches up.
{
  const app=makeApp();
  const workspace=new ProductWorkspace(app,{storage:new Storage(),backendFactory:()=>({})});
  app.workspace=workspace;
  await workspace.bind();
  const text=serializeHexProject(createHexProject({binary:workspace.identity,userNames:[{address:0x1000n,value:'from-a'}]}));
  let releaseImport;
  const input=new Blob([text]);
  Object.defineProperty(input,'text',{value:()=>new Promise((resolve)=>{releaseImport=()=>resolve(text);})});
  const pending=workspace.importProject(input);
  await Promise.resolve();
  assert.equal(typeof releaseImport,'function');

  const notesB=new Notes();
  app.backend.gen++;
  app.backend.contentHash=null;
  app.store.values.fileInfo=makeInfo('same.bin','B');
  app.store.values.file={name:'same.bin',size:4096};
  app.notes=notesB;
  releaseImport();

  let stale=null;
  try{await pending;}catch(error){stale=error;}
  assert.equal(stale?.code,'HEX_WORKSPACE_STALE');
  assert.equal(notesB.names.size,0,'stale project import must not mutate the new file notes');
}

${marker}`;
replaceOnce('tests/review-cross-binary-state.mjs', marker, insertion);

console.log('final workspace import hardening applied');