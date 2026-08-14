import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const server=http.createServer((req,res)=>{
  const pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
  if(pathname==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><body></body>');return;}
  const file=path.resolve(root,'.'+pathname);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||fs.statSync(file).isDirectory()){res.writeHead(404);res.end('not found');return;}
  res.setHeader('content-type',file.endsWith('.js')?'text/javascript; charset=utf-8':'text/plain; charset=utf-8');fs.createReadStream(file).pipe(res);
});
await new Promise((r)=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage(); await page.goto(`http://127.0.0.1:${port}/`);
  const result=await page.evaluate(async(port)=>{
    const {PluginHost}=await import(`http://127.0.0.1:${port}/js/plugins.js`);
    const {runInSandbox}=await import(`http://127.0.0.1:${port}/js/sandbox.js`);
    localStorage.clear();
    const source=`hex.plugin({name:'one',run(){}}); hex.plugin({name:'two',run(){}});`;
    const h1=new PluginHost({}); await h1.ready; h1.clear();
    const installed=await h1.install(source,'fixture');
    const first=h1.plugins.map((p)=>p.id);
    const h2=new PluginHost({}); await h2.ready;
    const second=h2.plugins.map((p)=>p.id);
    h2.remove(second[0]);
    const h3=new PluginHost({}); await h3.ready;
    const afterRemove=h3.plugins.map((p)=>p.id);
    const added=await h3.install(`hex.plugin({name:'three',run(){}});`,'fixture2');
    const newId=added.added[0].id;

    let aborted=false;
    const cancelResult=await runInSandbox({
      source:`await hex.long();`,mode:'script',timeout:80,
      api:{long:()=>new Promise(()=>{})},
      invoke:async(_method,_args,signal)=>new Promise((_resolve,reject)=>{
        signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));},{once:true});
      }),out:()=>{},
    });

    const budgetResult=await runInSandbox({
      source:`await Promise.all(Array.from({length:12},()=>hex.wait()));`,mode:'script',timeout:1000,
      api:{wait:()=>new Promise((r)=>setTimeout(()=>r(true),100))},out:()=>{},budgets:{maxConcurrent:3},
    });
    return {ok:installed.ok,first,second,afterRemove,newId,aborted,cancelError:cancelResult.error,budgetError:budgetResult.error};
  },port);
  assert.equal(result.ok,true);
  assert.equal(result.first.length,2); assert.deepEqual(result.second,result.first);
  assert.equal(result.afterRemove.length,1);
  assert.ok(!result.first.includes(result.newId),'removed plugin ID must never be reused');
  assert.equal(result.aborted,true); assert.match(result.cancelError,/時間制限/);
  assert.match(result.budgetError,/同時API/);
  console.log('plugin sandbox regression: ok');
}finally{await browser.close();await new Promise((r)=>server.close(r));}
