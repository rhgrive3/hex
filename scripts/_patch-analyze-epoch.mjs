import fs from 'node:fs';

{
  const path='js/backend.js';
  let s=fs.readFileSync(path,'utf8');
  const old=`  async analyze(sliceIndex) {
    if (this.formatId !== 'macho') return this._callTo('platform', 'analyze', { sliceIndex });
    const file = this.file;
    const legacy = await this._callTo('legacy', 'analyze', { sliceIndex });
    const enriched = await augmentAnalysisResultWithChainedImports(file, sliceIndex, legacy);
    if (!this.platformInfo?.normalizedDyldTruth) {
      return markMachOSymbolTruthIncomplete(enriched, this.legacyInfo?.platform?.normalizedDyldError || 'normalized-macho-analysis-unavailable');
    }
    try {
      const normalized = await this._callTo('platform', 'analyze', { sliceIndex });
      return mergeMachOAnalysisResults(enriched, normalized);
    } catch (error) {
      if (error?.stale) throw error;
      return markMachOSymbolTruthIncomplete(enriched, error?.message || 'normalized-macho-analysis-failed');
    }
  }`;
  const replacement=`  async analyze(sliceIndex) {
    if (this.formatId !== 'macho') return this._callTo('platform', 'analyze', { sliceIndex });
    const uiEpoch = this.gen, transportEpoch = this.transportEpoch, file = this.file;
    const assertCurrent = () => {
      if (uiEpoch !== this.gen || transportEpoch !== this.transportEpoch || file !== this.file) throw new StaleRequestError();
    };
    const legacy = await this._callTo('legacy', 'analyze', { sliceIndex });
    assertCurrent();
    const enriched = await augmentAnalysisResultWithChainedImports(file, sliceIndex, legacy);
    assertCurrent();
    if (!this.platformInfo?.normalizedDyldTruth) {
      return markMachOSymbolTruthIncomplete(enriched, this.legacyInfo?.platform?.normalizedDyldError || 'normalized-macho-analysis-unavailable');
    }
    try {
      const normalized = await this._callTo('platform', 'analyze', { sliceIndex });
      assertCurrent();
      return mergeMachOAnalysisResults(enriched, normalized);
    } catch (error) {
      if (error?.stale) throw error;
      assertCurrent();
      return markMachOSymbolTruthIncomplete(enriched, error?.message || 'normalized-macho-analysis-failed');
    }
  }`;
  if(!s.includes(old))throw new Error('analyze method snippet missing');
  fs.writeFileSync(path,s.replace(old,replacement));
}

{
  const path='tests/backend-open-race.mjs';
  let s=fs.readFileSync(path,'utf8');
  const marker="console.log('backend concurrent-open epoch regression: PASS');";
  if(!s.includes(marker))throw new Error('backend race test marker missing');
  const addition=`

// Multi-stage Mach-O analysis must keep the epoch captured at start. The local
// chained-import read is asynchronous; a slice switch during that read must not
// let the old analysis return under the new epoch.
{
  const analysisBackend=new Backend();
  const legacyAnalysisWorker=workers[workers.length-2];
  let releaseRead=null;
  const fakeFile={
    size:8,
    slice(){return {arrayBuffer(){return new Promise((resolve)=>{releaseRead=()=>resolve(new ArrayBuffer(8));});}};},
  };
  analysisBackend.formatId='macho';
  analysisBackend.file=fakeFile;
  analysisBackend.platformInfo={normalizedDyldTruth:false};
  analysisBackend.legacyInfo={platform:{}};
  let staleAnalysis=null;
  const analysis=analysisBackend.analyze(0);
  const observed=analysis.catch((error)=>{staleAnalysis=error;return null;});
  await tick();
  const request=find(legacyAnalysisWorker,(m)=>m.t==='analyze'&&m.sliceIndex===0);
  assert.ok(request);
  legacyAnalysisWorker.reply(request,{
    addrs:new BigUint64Array(0),kinds:new Uint8Array(0),flags:new Uint8Array(0),names:[],funcs:new BigUint64Array(0),
  });
  for(let i=0;i<10&&!releaseRead;i++)await tick();
  assert.ok(releaseRead,'chained-import augmentation should have started a file read');
  analysisBackend.advanceEpoch();
  releaseRead();
  await observed;
  assert.equal(staleAnalysis?.stale,true,'analysis crossing a slice epoch must reject as stale');
}
`;
  fs.writeFileSync(path,s.replace(marker,addition+'\n'+marker));
}
