import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createDevWorkerParentRpc } from '../../js/userscript/dev/parent-rpc.js';
import { createAuthBroadcastPort } from '../../js/userscript/dev/tab-mesh/auth-broadcast-port.js';
import { readWorkerTabTicket, encodeWorkerTabUrl, createWorkerTabTicket, scrubWorkerTabTicket } from '../../js/userscript/dev/tab-mesh/worker-tab-ticket.js';
import { MultiTabWorkerPool, DEV_WORKER_POOL_MAX } from '../../js/userscript/dev/tab-mesh/multi-tab-worker-pool.js';

async function testAuthenticatedBroadcastIsolation() {
  FakeBroadcastChannel.reset();
  const ticket = createWorkerTabTicket({ slot: 1, cryptoRef: webcrypto });
  const a = createAuthBroadcastPort(ticket, { BroadcastChannelRef: FakeBroadcastChannel });
  const b = createAuthBroadcastPort(ticket, { BroadcastChannelRef: FakeBroadcastChannel });
  const bad = createAuthBroadcastPort({ ...ticket, auth: 'f'.repeat(64) }, { BroadcastChannelRef: FakeBroadcastChannel });
  const seen = [];
  b.addEventListener('message', (event) => seen.push(event.data));
  a.postMessage({ hello: 1 });
  await tick();
  assert.deepEqual(seen, [{ hello: 1 }]);
  bad.postMessage({ forged: true });
  await tick();
  assert.deepEqual(seen, [{ hello: 1 }], 'wrong-auth channel traffic must be ignored');
  a.close(); b.close(); bad.close();
}

async function testConcurrentClaimReservesSlotBeforeRpcSettles() {
  FakeBroadcastChannel.reset();
  const servers = [];
  const openTab = async (href, { slot }) => {
    const ticket = readWorkerTabTicket(href);
    const port = createAuthBroadcastPort(ticket, { BroadcastChannelRef: FakeBroadcastChannel });
    servers.push(createDevWorkerParentRpc({ port, runtime: fakeDedicatedRuntime(slot) }));
    return { close() { port.close(); } };
  };
  const pool = new MultiTabWorkerPool({
    maxWorkers: 1,
    openTab,
    BroadcastChannelRef: FakeBroadcastChannel,
    cryptoRef: webcrypto,
    location: { href: 'https://chatgpt.com/' },
    sleep: async () => tick(),
  });
  await pool.provision({ size: 1, timeoutMs: 2000 });
  const firstClaim = pool.claim({ taskId: 'first', wait: false });
  await assert.rejects(
    pool.claim({ taskId: 'second', wait: false }),
    (error) => error?.code === 'worker-pool-full',
    'a slot whose remote claim is still settling must already be reserved locally',
  );
  const lease = await firstClaim;
  assert.equal(lease.slot, 1);
  assert.equal(pool.status().claimedCount, 1);
  await pool.release({ leaseId: lease.leaseId });
  pool.close();
  for (const server of servers) server.close();
}

async function testSixSlotsSeventhWaitsAndReuse() {
  FakeBroadcastChannel.reset();
  const servers = [];
  const openTab = async (href, { slot }) => {
    const ticket = readWorkerTabTicket(href);
    assert.equal(ticket.slot, slot);
    const port = createAuthBroadcastPort(ticket, { BroadcastChannelRef: FakeBroadcastChannel });
    const runtime = fakeDedicatedRuntime(slot);
    servers.push(createDevWorkerParentRpc({ port, runtime }));
    return { closed: false, close() { this.closed = true; port.close(); } };
  };
  const pool = new MultiTabWorkerPool({
    maxWorkers: 6,
    openTab,
    BroadcastChannelRef: FakeBroadcastChannel,
    cryptoRef: webcrypto,
    location: { href: 'https://chatgpt.com/' },
    sleep: async () => tick(),
  });
  const provisioned = await pool.provision({ size: 6, timeoutMs: 2000 });
  assert.equal(provisioned.readyCount, DEV_WORKER_POOL_MAX);
  const leases = [];
  for (let i = 0; i < 6; i++) leases.push(await pool.claim({ taskId: `task-${i}` }));
  assert.equal(new Set(leases.map((lease) => lease.slot)).size, 6, 'six distinct tabs must be claimable');
  assert.equal(pool.status().claimedCount, 6);

  let seventhSettled = false;
  const seventh = pool.claim({ taskId: 'task-7' }).then((value) => { seventhSettled = true; return value; });
  await tick();
  assert.equal(seventhSettled, false, 'seventh claim must wait while all six slots are occupied');

  await pool.createChat({ leaseId: leases[0].leaseId });
  await pool.start({ leaseId: leases[0].leaseId, instruction: 'worker zero' });
  await tick();
  const firstResult = await waitForResult(pool, leases[0].leaseId);
  assert.equal(firstResult.responseText, 'done:worker zero');
  await pool.release({ leaseId: leases[0].leaseId });
  const lease7 = await seventh;
  assert.equal(lease7.slot, leases[0].slot, 'freed slot must be reusable by the waiting seventh task');

  for (const lease of leases.slice(1)) await pool.release({ leaseId: lease.leaseId });
  await pool.release({ leaseId: lease7.leaseId });
  pool.close();
  for (const server of servers) server.close();
}

function testTicketScrub() {
  const ticket = createWorkerTabTicket({ slot: 2, cryptoRef: webcrypto, projectUrl: 'https://chatgpt.com/g/g-p-demo/project' });
  const href = encodeWorkerTabUrl(ticket);
  assert.ok(readWorkerTabTicket(href));
  const calls = [];
  const history = { state: null, replaceState(...args) { calls.push(args); } };
  const read = scrubWorkerTabTicket(history, { href });
  assert.equal(read.slot, 2);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0][2], /hex-dev-worker|auth=/, 'launch credential must be scrubbed from visible URL');
}

function fakeDedicatedRuntime(slot) {
  let claim = null;
  let result = null;
  return {
    async discover() { return [{ tabNodeId: `tab-${slot}`, role: claim ? 'worker' : 'available', state: claim ? 'working' : 'available', claimed: !!claim, dedicatedTab: true }]; },
    async claim(args) { claim = { runId: args.runId, workerId: args.workerId }; return { tabNodeId: `tab-${slot}`, ...claim, claimed: true, dedicatedTab: true }; },
    async createChat(args) { verify(args); return { ...claim, prepared: true }; },
    async send(args) { verify(args); await tick(); result = { status: 'completed', responseText: `done:${args.instruction}`, chatgptConversationId: `c-${slot}` }; return result; },
    async observe(args) { verify(args); return { status: result?.status || 'available' }; },
    async followup(args) { verify(args); result = { status: 'completed', responseText: `follow:${args.text}` }; return result; },
    async nudge(args) { verify(args); return { outcome: 'still-working' }; },
    async stop(args) { verify(args); return { outcome: 'not-running' }; },
    async result(args) { verify(args); return result || { status: 'available' }; },
    async release(args) { verify(args); claim = null; result = null; return { role: 'available', claimed: false }; },
    waitEvent() { return Promise.resolve({ type: 'worker.completed', data: claim || {} }); },
  };
  function verify(args) { assert.equal(args.runId, claim?.runId); assert.equal(args.workerId, claim?.workerId); }
}

async function waitForResult(pool, leaseId) {
  for (let i = 0; i < 20; i++) {
    const result = await pool.result({ leaseId });
    if (result.status !== 'working') return result;
    await tick();
  }
  throw new Error('pool result did not settle');
}

class FakeBroadcastChannel {
  static channels = new Map();
  static reset() { this.channels.clear(); }
  constructor(name) { this.name = name; this.listeners = new Set(); const set = FakeBroadcastChannel.channels.get(name) || new Set(); set.add(this); FakeBroadcastChannel.channels.set(name, set); }
  addEventListener(type, listener) { if (type === 'message') this.listeners.add(listener); }
  removeEventListener(type, listener) { if (type === 'message') this.listeners.delete(listener); }
  postMessage(data) { for (const peer of FakeBroadcastChannel.channels.get(this.name) || []) if (peer !== this) queueMicrotask(() => { for (const listener of peer.listeners) listener({ data }); peer.onmessage?.({ data }); }); }
  close() { FakeBroadcastChannel.channels.get(this.name)?.delete(this); this.listeners.clear(); }
}
function tick() { return new Promise((resolve) => setTimeout(resolve, 0)); }

await testAuthenticatedBroadcastIsolation();
await testConcurrentClaimReservesSlotBeforeRpcSettles();
await testSixSlotsSeventhWaitsAndReuse();
testTicketScrub();
console.log('multi-worker tab pool: ok');
