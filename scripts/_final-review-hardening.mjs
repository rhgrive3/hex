import fs from 'node:fs';

{
  const path = 'js/backend.js';
  let source = fs.readFileSync(path, 'utf8');
  const marker = '  async open(file) {\n    const previousTransportEpoch = this.transportEpoch;';
  const replacement = `  async open(file) {
    if (this.disposed) {
      const error = new Error('Backend has been disposed.'); error.code = 'BACKEND_DISPOSED';
      throw error;
    }
    const previousTransportEpoch = this.transportEpoch;`;
  if (!source.includes(marker)) throw new Error('Backend.open marker missing');
  source = source.replace(marker, replacement);
  fs.writeFileSync(path, source);
}

{
  const path = 'tests/backend-disposal.mjs';
  let source = fs.readFileSync(path, 'utf8');
  const marker = `  const workersBefore=workers.length;
  const disposedProbe=await b.probeArchitectures();
  assert.equal(disposedProbe.ok,false);
  assert.equal(workers.length,workersBefore,'disposed backend must not spawn probe workers');`;
  const replacement = `${marker}
  const messagesBefore=workers.slice(0,2).reduce((sum,w)=>sum+w.sent.length,0);
  await assert.rejects(()=>b.open({name:'disposed.bin',size:1}), (error)=>error?.code==='BACKEND_DISPOSED');
  const messagesAfter=workers.slice(0,2).reduce((sum,w)=>sum+w.sent.length,0);
  assert.equal(messagesAfter,messagesBefore,'disposed backend open must not post to terminated workers');`;
  if (!source.includes(marker)) throw new Error('backend disposal test marker missing');
  source = source.replace(marker, replacement);
  fs.writeFileSync(path, source);
}
