import fs from 'node:fs';

function replaceBlock(target, source, startMarker, endMarker) {
  const sourceStart = source.indexOf(startMarker);
  const sourceEnd = source.indexOf(endMarker, sourceStart);
  const targetStart = target.indexOf(startMarker);
  const targetEnd = target.indexOf(endMarker, targetStart);
  if ([sourceStart, sourceEnd, targetStart, targetEnd].some((x) => x < 0)) throw new Error(`missing block ${startMarker}`);
  return target.slice(0, targetStart) + source.slice(sourceStart, sourceEnd) + target.slice(targetEnd);
}

{
  let lifecycle = fs.readFileSync('js/backend.js', 'utf8');
  const race = fs.readFileSync('.integration/backend-race.js', 'utf8');
  lifecycle = replaceBlock(lifecycle, race, '  async open(file) {', '\n  probe() {');
  fs.writeFileSync('js/backend.js', lifecycle);
}

{
  let s = fs.readFileSync('js/workspace.js', 'utf8');
  const oldReset = '  _resetBoundState(){this.bindingRevision++;this.baselineSequence++;this.project=null;this.baseline=null;this.diffState=null;this.busy=null;}';
  const newReset = '  _resetBoundState(){const previous=this.baseline;this.bindingRevision++;this.baselineSequence++;this.project=null;this.baseline=null;this.diffState=null;this.busy=null;if(previous?.ownedBackend)previous.backend?.dispose?.();}';
  if (!s.includes(oldReset)) throw new Error('workspace reset snippet missing');
  s = s.replace(oldReset, newReset);
  const start = s.indexOf('  async loadBaseline(file,{backend=null}={}){');
  const end = s.indexOf('\n  async diff(options={}){', start);
  if (start < 0 || end < 0) throw new Error('workspace loadBaseline block missing');
  const replacement = `  async loadBaseline(file,{backend=null}={}){
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
      if(currentArch&&arch&&currentArch!==arch){const error=new Error(\`architecture mismatch: \${currentArch} vs \${arch}\`);error.code='DIFF_ARCH_MISMATCH';throw error;}
      const hash=await other.ensureContentHash();assertCurrent();
      const result=await other.analyze(sliceIndex);assertCurrent();
      const symbols=new SymbolIndex({...result,regions:slice?.regions||[]});
      const functions=functionsFromSymbols(symbols);assertCurrent();
      const previous=this.baseline;
      this.baseline={file,backend:other,ownedBackend,info,sliceIndex,slice,architecture:arch,hash,symbols,functions,complete:functions.complete===true};
      if(previous?.ownedBackend&&previous.backend!==other)previous.backend?.dispose?.();
      this.diffState=null;return this.baseline;
    }catch(error){if(ownedBackend)other?.dispose?.();throw error;}
  }`;
  s = s.slice(0, start) + replacement + s.slice(end);
  const tail = '  getBinaryDiff(){return this.diffState;}\n}';
  if (!s.includes(tail)) throw new Error('workspace class tail missing');
  s = s.replace(tail, "  getBinaryDiff(){return this.diffState;}\n  dispose(){this.bindSequence++;this.identity=null;this._resetBoundState();}\n}");
  fs.writeFileSync('js/workspace.js', s);
}

{
  const path = 'package.json';
  const data = JSON.parse(fs.readFileSync(path, 'utf8'));
  const prefix = [
    'node tests/backend-open-race.mjs',
    'node tests/review-cross-binary-state.mjs',
    'node tests/backend-disposal.mjs',
  ];
  const tests = data.scripts.test.split('&&').map((x) => x.trim());
  for (const cmd of [...prefix].reverse()) if (!tests.includes(cmd)) tests.unshift(cmd);
  data.scripts.test = tests.join(' && ');
  const userscript = data.scripts['userscript:test'].split('&&').map((x) => x.trim());
  const version = 'node tests/userscript-version.mjs';
  if (!userscript.includes(version)) {
    const marker = userscript.indexOf('node tests/ai-chatgpt-web-provider.mjs');
    userscript.splice(marker < 0 ? userscript.length : marker, 0, version);
  }
  data.scripts['userscript:test'] = userscript.join(' && ');
  fs.writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}
