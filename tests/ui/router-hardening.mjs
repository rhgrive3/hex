import assert from 'node:assert/strict';
import { matchRoute, ProductRouter } from '../../js/ui/router.js';

const routes=[
  { id:'fallback', pattern:'/fallback' },
  { id:'ok', pattern:'/ok/:id?' },
  { id:'boom', pattern:'/boom' },
];
assert.doesNotThrow(()=>matchRoute(routes,'/ok/%E0%A4%A'));
assert.equal(matchRoute(routes,'/ok/%E0%A4%A').params.id,'%E0%A4%A');

const listeners=new Map(); const raf=[];
globalThis.requestAnimationFrame=(fn)=>{ raf.push(fn); return raf.length; };
const location={ hash:'#/ok/one', href:'https://example.test/#/ok/one' };
globalThis.window={ location, addEventListener(type,fn){ listeners.set(type,fn); }, removeEventListener(type,fn){ if(listeners.get(type)===fn) listeners.delete(type); } };
const historyLog=[];
globalThis.history={
  state:{ hexUi:true, key:1, viewState:{ scroll:1 } }, length:2,
  pushState(state,_title,url){ this.state=state; location.hash=url.replace(/^#/,'#'); location.href='https://example.test/'+url; historyLog.push(['push',url]); },
  replaceState(state,_title,url){ this.state=state; if(url){ const hashAt=String(url).indexOf('#'); location.hash=hashAt>=0?String(url).slice(hashAt):location.hash; location.href=String(url); } historyLog.push(['replace',url]); },
  back(){ historyLog.push(['back']); }, forward(){ historyLog.push(['forward']); },
};

const diagnostics=[]; const restorations=[]; let disposed=0; let captureThrows=false; let restoreThrows=false;
const makeView=(path)=>({
  getState(){ if(captureThrows) throw new Error('capture boom'); return { path }; },
  restoreState(state){ if(restoreThrows) throw new Error('restore boom'); restorations.push([path,state]); },
  dispose(){ disposed++; },
});
const router=new ProductRouter(routes,{
  defaultPath:'/fallback', onDiagnostic:(d)=>diagnostics.push(d),
  onRoute:(current)=>{ if(current.route.id==='boom') throw new Error('render boom'); return makeView(current.fullPath); },
});
router.start();
assert.equal(router.current.fullPath,'/ok/one');
assert.equal(raf.length,1);

assert.equal(router.navigate('/ok/two'),true);
raf.shift()();
assert.equal(restorations.length,0);

captureThrows=true;
assert.equal(router.navigate('/ok/three'),true);
captureThrows=false;
assert.equal(router.current.fullPath,'/ok/three');
assert.ok(diagnostics.some((d)=>d.code==='ROUTER_CAPTURE_FAILED'));

const beforeCurrent=router.current; const beforeView=router.view; const disposedBefore=disposed;
assert.equal(router.navigate('/boom'),false);
assert.equal(router.current,beforeCurrent);
assert.equal(router.view,beforeView);
assert.equal(disposed,disposedBefore);
assert.ok(diagnostics.some((d)=>d.code==='ROUTER_RENDER_FAILED'));

history.state={ hexUi:true, key:50, viewState:{ scroll:99 } };
restoreThrows=true;
assert.equal(router._render('/ok/restore',{historyNavigation:true}),true);
const restoreRaf=raf.pop(); assert.equal(typeof restoreRaf,'function');
assert.doesNotThrow(()=>restoreRaf());
restoreThrows=false;
assert.ok(diagnostics.some((d)=>d.code==='ROUTER_RESTORE_FAILED'));

location.hash='#/ok/manual'; history.state={ hexUi:true, key:51, viewState:null };
listeners.get('hashchange')();
assert.equal(router.current.fullPath,'/ok/manual');

location.hash='#/does-not-exist'; history.state={ hexUi:true, key:52, viewState:null };
assert.equal(router._render('/does-not-exist',{historyNavigation:true}),true);
assert.equal(router.current.fullPath,'/fallback');
assert.equal(location.hash,'#/fallback');
assert.ok(historyLog.some(([kind,url])=>kind==='replace'&&url==='#/fallback'));

router.stop();
assert.equal(listeners.has('hashchange'),false);
console.log('router-hardening: PASS');
