import { WorkerChatController } from '../worker-host/worker-chat-controller.js';
import { createTabNode, TAB_NODE_ROLE } from './tab-node.js';
import { DedicatedWorkerCoordinator } from './dedicated-worker-coordinator.js';
import { createAuthBroadcastPort } from './auth-broadcast-port.js';
import { readWorkerTabTicket, scrubWorkerTabTicket } from './worker-tab-ticket.js';
import { createDevWorkerParentRpc } from '../parent-rpc.js';

export function isDedicatedWorkerTab(locationRef = globalThis.location) {
  return !!readWorkerTabTicket(locationRef);
}

export async function startDedicatedWorkerTabRuntime(options = {}) {
  const locationRef = options.location || globalThis.location;
  const ticket = options.ticket || scrubWorkerTabTicket(options.history || globalThis.history, locationRef);
  if (!ticket) throw new Error('Dedicated Worker tab ticket is missing.');
  const node = createTabNode({ role: TAB_NODE_ROLE.WORKER, now: options.now });
  const controller = options.controller || new WorkerChatController({ document: options.document || globalThis.document, now: options.now });
  const coordinator = new DedicatedWorkerCoordinator({ controller, tabNodeId: node.tabNodeId, now: options.now });
  const port = options.port || createAuthBroadcastPort(ticket, { BroadcastChannelRef: options.BroadcastChannelRef || globalThis.BroadcastChannel });
  const rpc = createDevWorkerParentRpc({ port, runtime: coordinator });
  try { globalThis.__HEX_DEV_DEDICATED_WORKER__ = Object.freeze({ poolId: ticket.poolId, slot: ticket.slot, tabNodeId: node.tabNodeId }); } catch {}
  return Object.freeze({ mode:'dedicated-worker-tab', ticket, node, coordinator, port, close(){ rpc.close(); coordinator.close(); port.close?.(); } });
}
