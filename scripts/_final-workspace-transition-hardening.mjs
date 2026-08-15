import fs from 'node:fs';

function replaceOnce(path, before, after) {
  const source=fs.readFileSync(path,'utf8');
  const at=source.indexOf(before);
  if(at<0)throw new Error(`${path}: expected block not found`);
  if(source.indexOf(before,at+1)>=0)throw new Error(`${path}: expected block not unique`);
  fs.writeFileSync(path,source.slice(0,at)+after+source.slice(at+before.length));
}

replaceOnce('js/workspace.js',
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
  }`,
`  async importProject(input){
    const liveHash=this.app?.backend?.contentHash||null;
    const liveKey=liveHash?identityKey(binaryIdentity(this.app,liveHash)):'';
    if(!this.identity||!liveHash||identityKey(this.identity)!==liveKey)await this.bind();
    if(!this.identity)throw staleWorkspaceError();
    const revision=this.bindingRevision, boundKey=identityKey(this.identity);
    const sourceInfo=this.app?.store?.get?.('fileInfo')||null;
    const sourceSlice=this.app?.store?.get?.('sliceIndex')??-1;
    const sourceBackendGen=this.app?.backend?.gen;
    const assertCurrent=()=>{
      this._assertBinding(revision);
      const currentHash=this.app?.backend?.contentHash||null;
      const currentLiveKey=currentHash?identityKey(binaryIdentity(this.app,currentHash)):'';
      if(identityKey(this.identity)!==boundKey || currentLiveKey!==boundKey || this.app?.store?.get?.('fileInfo')!==sourceInfo ||
        (this.app?.store?.get?.('sliceIndex')??-1)!==sourceSlice ||
        (sourceBackendGen!=null&&this.app?.backend?.gen!==sourceBackendGen) || !currentHash)throw staleWorkspaceError();
    };
    const project=await importHexProject(input);assertCurrent();
    const match=sameProjectIdentity(project,this.identity);
    if(!match.ok){const error=new Error(match.reason);error.code='HEX_PROJECT_BINARY_MISMATCH';error.detail=match;throw error;}
    applyWorkspaceProject(this.app,project);this.project=project;this.autosave();return project;
  }`);

replaceOnce('js/workspace.js',
`  getBinaryDiff(){return this.diffState;}
  dispose(){this.bindSequence++;this.identity=null;this._resetBoundState();}
}`,
`  getBinaryDiff(){return this.diffState;}
  invalidate(){this.bindSequence++;this.identity=null;this._resetBoundState();}
  dispose(){this.invalidate();}
}`);

replaceOnce('js/app.js',
`    const openEpoch=this.backend.gen;
    closeAllSheets();`,
`    const openEpoch=this.backend.gen;
    this.workspace?.invalidate();
    this.activeProject=null;
    closeAllSheets();`);

replaceOnce('js/app.js',
`    this.workspace?.autosave();
    this.noteAttachController?.abort();
    this.backend.advanceEpoch();`,
`    this.workspace?.autosave();
    this.workspace?.invalidate();
    this.activeProject=null;
    this.noteAttachController?.abort();
    this.backend.advanceEpoch();`);

replaceOnce('tests/review-cross-binary-state.mjs',
`import assert from 'node:assert/strict';`,
`import assert from 'node:assert/strict';
import fs from 'node:fs';`);

const marker=`// The real UI adapter must expose the live Backend/ProductWorkspace content hash
// as the strong identity used by TurnSnapshot/ObservationStore, not filename:slice.`;
const insertion=`// Starting an import after a same-file slice switch but before workspace.bind()
// must not trust the old slice identity merely because the content hash matches.
{
  const app=makeApp();
  const info=makeInfo('same.bin','A');
  info.slices=[
    {offset:0n,size:2048n,info:{uuid:'A0',architecture:'arm64'},capability:{architecture:'arm64'},regions:[region]},
    {offset:2048n,size:2048n,info:{uuid:'A1',architecture:'arm64'},capability:{architecture:'arm64'},regions:[region]},
  ];
  app.store.values.fileInfo=info;
  app.store.values.sliceIndex=0;
  const workspace=new ProductWorkspace(app,{storage:new Storage(),backendFactory:()=>({})});
  app.workspace=workspace;
  await workspace.bind();
  const text=serializeHexProject(createHexProject({binary:workspace.identity,userNames:[{address:0x1000n,value:'slice-a'}]}));

  const notesB=new Notes();
  app.backend.gen++;
  app.store.values.sliceIndex=1;
  app.notes=notesB;
  let rejected=null;
  try{await workspace.importProject(text);}catch(error){rejected=error;}
  assert.equal(rejected?.code,'HEX_PROJECT_BINARY_MISMATCH');
  assert.equal(rejected?.detail?.field,'sliceIndex');
  assert.equal(notesB.names.size,0,'old-slice project must not mutate the new slice notes');
  assert.equal(workspace.identity?.metadata?.sliceIndex,1,'import preflight must rebind to the live slice');
}

// The app must invalidate the bound workspace immediately when a new file or
// slice becomes active; waiting for async note attachment leaves a stale window.
{
  const source=fs.readFileSync(new URL('../js/app.js',import.meta.url),'utf8');
  const openBlock=source.slice(source.indexOf('  async openFile('),source.indexOf('  async attachNotes('));
  assert.match(openBlock,/const openEpoch=this\.backend\.gen;\s*this\.workspace\?\.invalidate\(\);\s*this\.activeProject=null;/);
  const sliceStart=source.indexOf('  async selectSlice(');
  const sliceEnd=source.indexOf('\n  }',sliceStart)+4;
  const sliceBlock=source.slice(sliceStart,sliceEnd);
  assert.match(sliceBlock,/this\.workspace\?\.autosave\(\);\s*this\.workspace\?\.invalidate\(\);\s*this\.activeProject=null;\s*this\.noteAttachController\?\.abort\(\);\s*this\.backend\.advanceEpoch\(\);/);
}

${marker}`;
replaceOnce('tests/review-cross-binary-state.mjs',marker,insertion);

console.log('workspace transition hardening applied');