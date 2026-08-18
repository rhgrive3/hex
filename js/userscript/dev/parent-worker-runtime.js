import { DEV_WORKER_FAILURE } from '../../ai/dev/workers/contracts.js';
import { createDevEvent, DEV_EVENT_TYPE } from '../../ai/dev/events/dev-events.js';
import { createTabNode, TAB_NODE_ROLE } from './frame-mesh/tab-node.js';
import { SingleConversationWorkerCoordinator } from './single-tab/single-conversation-worker-coordinator.js';
import { WorkerChatController } from './worker-host/worker-chat-controller.js';
import { ParentPageInspector } from './admin/page-inspector.js';
import { DomSkillRegistry } from './skills/dom-skill-registry.js';
import { IframeWorkerPool } from './frame-mesh/iframe-worker-pool.js';
import { DynamicTaskGraphHost } from './task-graph/dynamic-task-graph.js';
import { readDevRuntimeIdentityFromGlobals } from '../../ai/dev/bootstrap/self-update-gate.js';

const POOL_EVENT_POLL_MS = 50;
const POOL_TERMINAL_EVENTS = new Set([
  DEV_EVENT_TYPE.WORKER_COMPLETED,
  DEV_EVENT_TYPE.WORKER_FAILED,
  DEV_EVENT_TYPE.WORKER_CANCELLED,
]);

export async function startParentDevWorkerRuntime(options = {}) {
  const node = createTabNode({ role: TAB_NODE_ROLE.SUPERVISOR, now: options.now });
  const readIdentity = () => parentRuntimeIdentity(options);
  try {
    const controller = options.controller || new WorkerChatController({ document: options.document || globalThis.document, adapter: options.adapter, router: options.router, turns: options.turns, now: options.now });
    const coordinator = new SingleConversationWorkerCoordinator({ controller, tabNodeId: node.tabNodeId, now: options.now });
    const documentRef = options.document || controller.adapter?.document || globalThis.document;
    const locationRef = options.location || controller.adapter?.location || globalThis.location;
    const pageInspector = options.pageInspector || new ParentPageInspector({ document: documentRef, location: locationRef, fetchRef: options.fetchRef || globalThis.fetch?.bind(globalThis) });
    const skillRegistry = options.skillRegistry || new DomSkillRegistry({ document: documentRef, location: locationRef, now: options.now });
    const workerPool = options.workerPool || new IframeWorkerPool({
      createFrame: options.createFrame,
      createWorkerRuntime: options.createWorkerRuntime,
      documentRef,
      cryptoRef: options.cryptoRef || globalThis.crypto,
      location: locationRef,
      now: options.now,
      sleep: options.sleep,
    });
    const poolEventState = createPoolCompletionEventState();
    const taskGraphHost = options.taskGraphHost || new DynamicTaskGraphHost({
      workerPool,
      cryptoRef: options.cryptoRef || globalThis.crypto,
      now: options.now,
      sleep: options.sleep,
      pollMs: options.taskGraphPollMs,
      cleanupTimeoutMs: options.taskGraphCleanupTimeoutMs,
    });
    return Object.freeze({
      role:'supervisor', mode:'multi-frame-capable', enabled:true, tabNodeId:node.tabNodeId, coordinator, skillRegistry, workerPool, taskGraphHost,
      discover:(args)=>coordinator.discover(args), claim:(args,opts={})=>claimWithCancellationCleanup(coordinator,args,opts.signal), createChat:(args)=>coordinator.createChat(args), send:(args)=>coordinator.send(args), observe:(args)=>coordinator.observe(args), followup:(args)=>coordinator.followup(args), nudge:(args)=>coordinator.nudge(args), stop:(args)=>coordinator.stop(args), result:(args)=>coordinator.result(args), release:(args)=>coordinator.release(args), waitEvent:(args,opts={})=>waitForDevWorkerEvent(coordinator,workerPool,args,opts,poolEventState,{now:options.now,sleep:options.sleep}),
      runtimeIdentity:()=>readIdentity(),
      pageSnapshot:(args)=>pageInspector.snapshot(args), pageScripts:(args)=>pageInspector.scripts(args), pageScriptSource:(args,opts={})=>pageInspector.scriptSource(args,opts),
      skillList:()=>skillRegistry.list(), skillDescribe:(args)=>skillRegistry.describe(args), skillInstallCandidate:(args)=>skillRegistry.installCandidate(args?.manifest??args), skillValidateCandidate:(args,opts={})=>skillRegistry.validateCandidate({...args,signal:opts.signal}), skillActivate:(args)=>skillRegistry.activate(args), skillRollback:(args)=>skillRegistry.rollback(args), skillRun:(args,opts={})=>skillRegistry.run({...args,signal:opts.signal}),
      poolStatus:()=>workerPool.status(), poolProvision:(args)=>workerPool.provision(args), poolClaim:(args,opts={})=>workerPool.claim({...args,signal:opts.signal}), poolCreateChat:(args)=>workerPool.createChat(args), poolStart:(args)=>workerPool.start(args), poolObserve:(args)=>workerPool.observe(args), poolResult:(args)=>workerPool.result(args), poolFollowup:(args)=>workerPool.followup(args), poolNudge:(args)=>workerPool.nudge(args), poolStop:(args)=>workerPool.stop(args), poolRelease:(args)=>workerPool.release(args),
      taskGraphStart:(args)=>taskGraphHost.start(args), taskGraphStatus:(args)=>taskGraphHost.status(args), taskGraphTaskResult:(args)=>taskGraphHost.taskResult(args), taskGraphCancel:(args)=>taskGraphHost.cancel(args),
      close(){taskGraphHost.close();workerPool.close();coordinator.close();},
    });
  } catch(error) { return disabledRuntime({node,error,readIdentity}); }
}

export function createPoolCompletionEventState() {
  return { deliveredResults: new WeakSet() };
}

/* Pool turns intentionally remain asynchronous after worker.pool.start returns.
   The legacy wait transport only observed the single-conversation coordinator,
   so a completed iframe Worker could retain its result forever without waking
   the Supervisor. Multiplex the existing coordinator events with a read-only
   probe of retained pool results. No pool state is consumed or rewritten here. */
export async function waitForDevWorkerEvent(
  coordinator,
  workerPool,
  args = {},
  opts = {},
  state = createPoolCompletionEventState(),
  { now = () => new Date().toISOString(), sleep = delay } = {},
) {
  const events = Array.isArray(args?.events) ? args.events.map(String) : [];
  const wantsPoolTerminal = events.some((type) => POOL_TERMINAL_EVENTS.has(type));
  if (!wantsPoolTerminal || !workerPool || typeof workerPool.status !== 'function' || typeof workerPool.result !== 'function') {
    return coordinator.waitEvent(args, opts);
  }

  const immediate = await takePoolTerminalEvent(workerPool, events, state, now, opts.signal);
  if (immediate) return immediate;
  if (opts.signal?.aborted) throw abortError(opts.signal.reason);

  const controller = typeof globalThis.AbortController === 'function' ? new globalThis.AbortController() : null;
  const signal = controller?.signal || opts.signal || null;
  let onAbort = null;
  if (controller && opts.signal) {
    onAbort = () => controller.abort(opts.signal.reason);
    opts.signal.addEventListener?.('abort', onAbort, { once: true });
  }

  const coordinatorWait = Promise.resolve()
    .then(() => coordinator.waitEvent(args, { ...opts, signal }))
    .then((event) => ({ source: 'coordinator', event }));
  const poolWait = waitForPoolTerminalEvent(workerPool, events, state, { now, sleep, signal })
    .then((event) => ({ source: 'pool', event }));

  try {
    const winner = await Promise.race([coordinatorWait, poolWait]);
    controller?.abort('worker-event-delivered');
    return winner.event;
  } finally {
    if (onAbort) opts.signal?.removeEventListener?.('abort', onAbort);
  }
}

async function waitForPoolTerminalEvent(workerPool, events, state, { now, sleep, signal }) {
  while (true) {
    if (signal?.aborted) throw abortError(signal.reason);
    const event = await takePoolTerminalEvent(workerPool, events, state, now, signal);
    if (event) return event;
    await sleep(POOL_EVENT_POLL_MS);
  }
}

async function takePoolTerminalEvent(workerPool, events, state, now, signal) {
  if (signal?.aborted) throw abortError(signal.reason);
  const wanted = new Set(events);
  const slots = [...(workerPool.status()?.slots || [])].sort((a, b) => Number(a?.slot || 0) - Number(b?.slot || 0));
  for (const snapshot of slots) {
    if (signal?.aborted) throw abortError(signal.reason);
    if (!snapshot?.claimed || !snapshot.leaseId || snapshot.working) continue;
    let result;
    try { result = await workerPool.result({ leaseId: snapshot.leaseId }); }
    catch (error) { if (String(error?.code || '') === 'lease-missing') continue; throw error; }
    if (!result || typeof result !== 'object') continue;
    const type = poolTerminalEventType(result.status);
    if (!type || !wanted.has(type) || state.deliveredResults.has(result)) continue;

    // A release/reclaim or a new start can race the result read. Revalidate the
    // exact active lease before delivery so a stale retained object can never
    // wake a later Supervisor/Worker owner.
    const current = (workerPool.status()?.slots || []).find((slot) => Number(slot?.slot) === Number(snapshot.slot));
    if (!current?.claimed || current.leaseId !== snapshot.leaseId || current.workerId !== snapshot.workerId || current.working) continue;
    if (signal?.aborted) throw abortError(signal.reason);

    state.deliveredResults.add(result);
    return createDevEvent(type, {
      source: 'worker-pool',
      leaseId: snapshot.leaseId,
      slot: snapshot.slot,
      workerId: snapshot.workerId || null,
      taskId: snapshot.taskId || null,
      result: clonePoolResult(result),
    }, { now });
  }
  return null;
}

function poolTerminalEventType(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'completed' || value === 'succeeded' || value === 'success') return DEV_EVENT_TYPE.WORKER_COMPLETED;
  if (value === 'failed' || value === 'error') return DEV_EVENT_TYPE.WORKER_FAILED;
  if (value === 'cancelled' || value === 'canceled') return DEV_EVENT_TYPE.WORKER_CANCELLED;
  return null;
}

function clonePoolResult(result) {
  try { return JSON.parse(JSON.stringify(result)); }
  catch {
    return {
      status: String(result?.status || ''),
      responseText: result?.responseText == null ? null : String(result.responseText),
      chatgptConversationId: result?.chatgptConversationId == null ? null : String(result.chatgptConversationId),
    };
  }
}

async function claimWithCancellationCleanup(coordinator,args,signal) {
  if (signal?.aborted) throw abortError(signal.reason);
  const result = await coordinator.claim(args);
  if (!signal?.aborted) return result;
  try { await coordinator.release(args); } catch {}
  throw abortError(signal.reason);
}

/* The identity of the parent userscript runtime that is actually executing.
   A merged commit only becomes real here after the page reloads, so this is
   the authority the Dev Supervisor self-update gate checks against. */
export function parentRuntimeIdentity(options = {}) {
  return Object.freeze({
    realm: 'parent-userscript',
    ...readDevRuntimeIdentityFromGlobals(options.globalObject || globalThis, options.runtimeIdentity || {}),
  });
}

function disabledRuntime({node,error,readIdentity}) {
  const code=String(error?.code||DEV_WORKER_FAILURE.PROVIDER_ERROR), message=String(error?.message||'Dev Worker runtime is unavailable.');
  const fail=async()=>{const failure=new Error(message);failure.code=code;throw failure;};
  return Object.freeze({
    role:'supervisor',mode:'multi-frame-capable',enabled:false,tabNodeId:node.tabNodeId,error:Object.freeze({code,message}),
    discover:fail,claim:fail,createChat:fail,send:fail,observe:fail,followup:fail,nudge:fail,stop:fail,result:fail,release:fail,waitEvent:fail,
    runtimeIdentity:()=>(typeof readIdentity==='function'?readIdentity():parentRuntimeIdentity()),
    pageSnapshot:fail,pageScripts:fail,pageScriptSource:fail,skillList:fail,skillDescribe:fail,skillInstallCandidate:fail,skillValidateCandidate:fail,skillActivate:fail,skillRollback:fail,skillRun:fail,
    poolStatus:fail,poolProvision:fail,poolClaim:fail,poolCreateChat:fail,poolStart:fail,poolObserve:fail,poolResult:fail,poolFollowup:fail,poolNudge:fail,poolStop:fail,poolRelease:fail,
    taskGraphStart:fail,taskGraphStatus:fail,taskGraphTaskResult:fail,taskGraphCancel:fail,
    close(){},
  });
}

function abortError(reason) {
  const error = new Error(String(reason || 'cancelled'));
  error.name = 'AbortError';
  error.code = DEV_WORKER_FAILURE.CANCELLED;
  return error;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
