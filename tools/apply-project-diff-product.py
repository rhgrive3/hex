from pathlib import Path


def replace(path, old, new, label, count=1):
    p=Path(path); s=p.read_text()
    if old not in s: raise SystemExit(f'{label} anchor missing in {path}')
    p.write_text(s.replace(old,new,count))

# App owns one workspace adapter and checkpoints before binary/slice identity changes.
replace('js/app.js', "import { STRING_SCAN_BUDGET, StringCollectionBudget } from './string-budget.js';", "import { STRING_SCAN_BUDGET, StringCollectionBudget } from './string-budget.js';\nimport { ProductWorkspace } from './workspace.js';", '#547 workspace import')
replace('js/app.js', """    this.viewer.attachScrubber(this.dom.scrubber, this.dom.thumb);

    this.applyTheme""", """    this.viewer.attachScrubber(this.dom.scrubber, this.dom.thumb);
    this.workspace = new ProductWorkspace(this);
    this.activeProject = null;

    this.applyTheme""", '#547 workspace constructor')
replace('js/app.js', """  async openFile(file, opts) {
    if (!file) return;
    if (file.size === 0)""", """  async openFile(file, opts) {
    if (!file) return;
    if (file.size === 0)""", '#547 open anchor')
replace('js/app.js', """    const sampleOpen = !!(opts && opts.sample);
    this.setBusy(true, t('status.reading', { name:file.name }));""", """    const sampleOpen = !!(opts && opts.sample);
    this.workspace?.autosave();
    this.setBusy(true, t('status.reading', { name:file.name }));""", '#547 autosave before open')
replace('js/app.js', """    this.applySlice(sliceIndex,info);
    void this.attachNotes(file,info,sliceIndex,openEpoch);""", """    this.applySlice(sliceIndex,info);
    void this.attachNotes(file,info,sliceIndex,openEpoch)
      .then(()=>this.workspace?.bind())
      .then((project)=>{if(project)this.activeProject=project;})
      .catch(()=>{});""", '#547 bind project after notes')
replace('js/app.js', """  async selectSlice(index) {
    const info=this.store.get('fileInfo');
    if (!info || !info.slices[index] || info.slices[index].error) return;
    this.noteAttachController?.abort();""", """  async selectSlice(index) {
    const info=this.store.get('fileInfo');
    if (!info || !info.slices[index] || info.slices[index].error) return;
    this.workspace?.autosave();
    this.noteAttachController?.abort();""", '#547 autosave before slice')
replace('js/app.js', """    this.applySlice(index,info);
    void this.attachNotes(file,info,index,epoch);
  }""", """    this.applySlice(index,info);
    void this.attachNotes(file,info,index,epoch)
      .then(()=>this.workspace?.bind())
      .then((project)=>{if(project)this.activeProject=project;})
      .catch(()=>{});
  }

  async exportProjectFile(){
    if(!this.store.get('fileInfo'))throw new Error('open-file-first');
    if(!this.workspace.identity)this.activeProject=await this.workspace.bind();
    return this.workspace.exportProject();
  }

  async importProjectFile(file){
    if(!this.store.get('fileInfo'))throw new Error('open-file-first');
    if(!this.workspace.identity)await this.workspace.bind();
    const project=await this.workspace.importProject(file);this.activeProject=project;this.updateChrome();return project;
  }

  async loadDiffBaseline(file){return this.workspace.loadBaseline(file);}
  async runBinaryDiff(options){return this.workspace.diff(options);}
  getBinaryDiff(){return this.workspace.getBinaryDiff();}
  saveWorkspace(){return this.workspace.autosave();}
""", '#547/#548 App workspace methods')

# Canonical route registry: Binary Diff is a first-class product screen.
replace('js/ui/registry.js', """  { id: 'results', pattern: '/results', title: '結果', kind: 'screen', primary: true },
  { id: 'function'""", """  { id: 'results', pattern: '/results', title: '結果', kind: 'screen', primary: true },
  { id: 'diff', pattern: '/diff', title: '差分', kind: 'screen' },
  { id: 'function'""", '#548 diff route')

# Product UI helpers for project export/import and diff baseline selection.
p=Path('js/ui/product.js'); s=p.read_text()
marker='function renderAdvanced(app) {'
idx=s.index(marker)
helpers=r'''function pickOneFile(accept='') {
  return new Promise((resolve) => {
    const input=document.createElement('input'); input.type='file'; input.accept=accept;
    input.style.position='fixed'; input.style.left='-10000px'; document.body.append(input);
    const finish=(file)=>{input.remove();resolve(file||null);};
    input.addEventListener('change',()=>finish(input.files?.[0]||null),{once:true});
    input.addEventListener('cancel',()=>finish(null),{once:true});
    input.click();
  });
}
function downloadBlob(blob,name) {
  const url=URL.createObjectURL(blob); const a=document.createElement('a');
  a.href=url;a.download=name||'analysis.hexproj';a.style.display='none';document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function exportProjectFromProduct(app) {
  try { const blob=await app.exportProjectFile(); downloadBlob(blob,(app.store.get('fileInfo')?.name||'analysis')+'.hexproj'); toast(text('プロジェクトを書き出しました。','Project exported.')); }
  catch(error){toast(text('プロジェクトを書き出せませんでした: ','Could not export project: ')+String(error?.message||error));}
}
async function importProjectFromProduct(app) {
  const file=await pickOneFile('.hexproj,application/json'); if(!file)return;
  try { await app.importProjectFile(file); toast(text('プロジェクトを復元しました。','Project restored.')); }
  catch(error){const mismatch=error?.code==='HEX_PROJECT_BINARY_MISMATCH';toast(mismatch?text('このプロジェクトは現在のバイナリ/スライス用ではありません。','This project belongs to a different binary or slice.'):text('プロジェクトを読み込めませんでした: ','Could not import project: ')+String(error?.message||error));}
}

function renderDiff(app,router) {
  const s=screen(text('バイナリ差分','Binary Diff'),{id:'diff',subtitle:text('前のバージョンと現在のバージョンを関数単位で比較します。','Compare a previous version with the current binary at function granularity.')});
  const host=h('div','ui-stack');s.body.append(host);
  if(!app.store.get('fileInfo')){host.append(emptyState(text('先に現在のバイナリを開いてください','Open the current binary first'),'',uiButton(text('コードへ','Go to Code'),{onClick:()=>router.navigate('/code')})));return {root:s.root};}
  const state=app.getBinaryDiff?.(); const baseline=app.workspace?.baseline;
  const controls=h('div','ui-actions');
  controls.append(uiButton(baseline?text('比較元を変更','Change baseline'):text('前のバージョンを選ぶ','Choose previous version'),{cls:'ui-primary-action',onClick:async()=>{
    const file=await pickOneFile();if(!file)return;host.replaceChildren(loadingState(text('比較元を解析しています…','Analysing baseline…')));
    try{await app.loadDiffBaseline(file);await app.runBinaryDiff();router.navigate('/diff',{replace:true});}
    catch(error){host.replaceChildren(errorState(text('比較できませんでした','Could not compare'),String(error?.message||error)));}
  }}));
  if(baseline)controls.append(uiButton(text('再比較','Compare again'),{onClick:async()=>{host.replaceChildren(loadingState(text('比較しています…','Comparing…')));try{await app.runBinaryDiff();router.navigate('/diff',{replace:true});}catch(error){host.replaceChildren(errorState(text('比較できませんでした','Could not compare'),String(error?.message||error)));}}}));
  host.append(controls);
  if(!state){host.append(emptyState(text('比較元を選ぶと変更された関数を抽出します','Choose a baseline to find changed functions'),text('同一CPU/スライスだけを比較し、不完全な探索では new/deleted を断定しません。','Only matching architectures/slices are compared; incomplete matching never invents new/deleted certainty.')));return {root:s.root};}
  const counts={same:0,moved:0,changed:0,rewritten:0,new:0,deleted:0,unresolved:0};
  for(const c of state.changes||[])counts[c.changeType]=(counts[c.changeType]||0)+1;
  const summary=card(text('比較結果','Diff summary'));
  summary.body.append(h('p','ui-body',`${counts.changed||0} changed · ${counts.rewritten||0} rewritten · ${counts.moved||0} moved · ${counts.new||0} new · ${counts.deleted||0} deleted · ${counts.unresolved||0} unresolved`));
  summary.body.append(h('p',state.completeness?.complete?'ui-sub':'ui-warning',state.completeness?.complete?text('関数集合とmatchingは完全です。','Function sets and matching are complete.'):text('部分結果です: ','Partial result: ')+(state.completeness?.reasons||[]).join(', ')));
  host.append(summary.root);
  const interesting=(state.changes||[]).filter((c)=>c.changeType!=='same').slice(0,5000);
  const render=(c)=>{const current=c.after?.address??null;const previous=c.before?.address??null;const title=c.after?.name||c.before?.name||(current!=null?functionName(app,current):text('削除された関数','Deleted function'));const tags=c.semanticChange?.tags?.join(', ')||'';return listRow({title,subtitle:[c.changeType,current!=null?addressText(current):previous!=null?'old '+addressText(previous):'',tags].filter(Boolean).join(' · '),badge:evidenceBadge(c.changeType==='unresolved'?'unverified':c.confidence>=0.82?'confirmed':'likely'),onClick:current!=null?()=>router.navigate('/function/'+BigInt(current).toString()+'/overview'):null});};
  if(interesting.length>100)host.append(new VirtualList({items:interesting,rowHeight:64,ariaLabel:text('変更関数','Changed functions'),renderRow:render}).root);else{const list=h('div','ui-list');for(const c of interesting)list.append(render(c));host.append(list);}
  return {root:s.root};
}

'''
s=s[:idx]+helpers+s[idx:]
# Advanced entries.
s=s.replace("""  list.append(listRow({ title: text('解析ツール一覧', 'Analysis tools'), subtitle: text('パッチ・スクリプト・プラグイン等', 'Patching, scripting, plugins, etc.'), onClick: () => requireFile(app, () => showTools(app)) }));""", """  list.append(listRow({ title: text('解析ツール一覧', 'Analysis tools'), subtitle: text('パッチ・スクリプト・プラグイン等', 'Patching, scripting, plugins, etc.'), onClick: () => requireFile(app, () => showTools(app)) }));
  list.append(listRow({ title:text('プロジェクトを書き出す (.hexproj)','Export project (.hexproj)'), subtitle:text('名前・メモ・型・patch・解析結果・AI調査・移動履歴を保存','Save names, notes, types, patches, findings, AI investigation and navigation'), onClick:()=>requireFile(app,()=>exportProjectFromProduct(app)) }));
  list.append(listRow({ title:text('プロジェクトを読み込む','Import project'), subtitle:text('現在のバイナリhashとsliceが一致した場合だけ復元します','Restores only when binary hash and slice identity match'), onClick:()=>requireFile(app,()=>importProjectFromProduct(app)) }));
  list.append(listRow({ title:text('バージョン差分','Binary Diff'), subtitle:text('前のバイナリと変更関数を比較','Compare changed functions against a previous binary'), onClick:()=>requireFile(app,()=>window.__hexUi?.router?.navigate('/diff')) }));""",1)
# Router.
s=s.replace("""      else if (route.route.id === 'results' || route.route.id === 'finding') view = renderResults(app, router);
      else if (route.route.id === 'advanced') view = renderAdvanced(app);""", """      else if (route.route.id === 'results' || route.route.id === 'finding') view = renderResults(app, router);
      else if (route.route.id === 'diff') view = renderDiff(app, router);
      else if (route.route.id === 'advanced') view = renderAdvanced(app);""",1)
# Autosave on pagehide while keeping router capture.
s=s.replace("window.addEventListener('pagehide', () => router.capture(), { passive: true });", "window.addEventListener('pagehide', () => { router.capture(); app.saveWorkspace?.(); }, { passive: true });",1)
p.write_text(s)

# AI receives the authoritative project document and read-only diff tool contract.
replace('js/ai/ui/hex-context.js', """    get project() {
      return {
        names: app.notes ? app.notes.nameEntries().slice(0, 400) : [],
        lastGoal: app.lastGoal ? app.lastGoal.text : null,
      };
    },""", """    get project() {
      return app.workspace?.project || app.activeProject || {
        binary:null,user:{names:app.notes?app.notes.nameEntries().slice(0,400):[]},navigation:{lastQuery:app.lastGoal?.text||null},
      };
    },
    get binaryDiff() { return app.getBinaryDiff?.() || null; },
    getBinaryDiff: () => app.getBinaryDiff?.() || null,""", '#547/#548 AI workspace context')

print('applied #547/#548 App/Product/AI wiring')
