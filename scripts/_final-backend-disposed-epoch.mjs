import fs from 'node:fs';

function replaceOnce(path,before,after){
  const source=fs.readFileSync(path,'utf8');
  const at=source.indexOf(before);
  if(at<0)throw new Error(`${path}: expected block not found`);
  if(source.indexOf(before,at+1)>=0)throw new Error(`${path}: expected block not unique`);
  fs.writeFileSync(path,source.slice(0,at)+after+source.slice(at+before.length));
}

replaceOnce('js/backend.js',
`  advanceEpoch() {
    this.analysisEpoch++;
    this.resetCache();`,
`  advanceEpoch() {
    if (this.disposed) return this.analysisEpoch;
    this.analysisEpoch++;
    this.resetCache();`);

replaceOnce('tests/backend-disposal.mjs',
`  const messagesAfter=workers.slice(0,2).reduce((sum,w)=>sum+w.sent.length,0);
  assert.equal(messagesAfter,messagesBefore,'disposed backend open must not post to terminated workers');`,
`  const messagesAfter=workers.slice(0,2).reduce((sum,w)=>sum+w.sent.length,0);
  assert.equal(messagesAfter,messagesBefore,'disposed backend open must not post to terminated workers');
  const epochAfterDispose=b.gen;
  assert.equal(b.advanceEpoch(),epochAfterDispose,'disposed backend epoch advance must be a no-op');
  const messagesAfterEpoch=workers.slice(0,2).reduce((sum,w)=>sum+w.sent.length,0);
  assert.equal(messagesAfterEpoch,messagesAfter,'disposed backend epoch advance must not post to terminated workers');`);

console.log('disposed backend epoch guard applied');