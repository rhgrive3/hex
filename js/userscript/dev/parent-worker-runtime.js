import { DEV_WORKER_FAILURE } from '../../ai/dev/workers/contracts.js';
import { createTabNode, isManualWorkerTab, TAB_NODE_ROLE } from './tab-mesh/tab-node.js';
import { createBrowserTabTransport } from './tab-mesh/transport.js';
import { SingleWorkerCoordinator } from './tab-mesh/single-worker-coordinator.js';
import { WorkerTabHost } from './worker-host/worker-host.js';

export async function startParentDevWorkerRuntime(options = {}) {
  const workerMode = options.workerMode ?? isManualWorkerTab({
    location: options.location || globalThis.location,
    window: options.window || globalThis.window,
  });
  const node = createTabNode({
    role: workerMode ? TAB_NODE_ROLE.AVAILABLE : TAB_NODE_ROLE.SUPERVISOR,
    now: options.now,
  });
  let transport;
  try {
    transport = options.transport || await createBrowserTabTransport({
      nodeId: node.tabNodeId,
      secret: options.secret,
      BroadcastChannelCtor: options.BroadcastChannelCtor,
      cryptoRef: options.cryptoRef,
      channelName: options.channelName,
      now: options.clock,
    });
  } catch (error) {
    return disabledRuntime({ workerMode, node, error });
  }

  if (workerMode) {
    const host = new WorkerTabHost({ transport, tabNode: node, controller: options.controller, now: options.now });
    await host.register().catch(() => {});
    return Object.freeze({
      role: 'worker',
      enabled: true,
      tabNodeId: node.tabNodeId,
      host,
      close() { host.close(); transport.close(); },
    });
  }

  const coordinator = new SingleWorkerCoordinator({ transport, now: options.now });
  return Object.freeze({
    role: 'supervisor',
    enabled: true,
    tabNodeId: node.tabNodeId,
    coordinator,
    discover: (args) => coordinator.discover(args),
    claim: (args) => coordinator.claim(args),
    createChat: (args) => coordinator.createChat(args),
    send: (args) => coordinator.send(args),
    observe: (args) => coordinator.observe(args),
    followup: (args) => coordinator.followup(args),
    nudge: (args) => coordinator.nudge(args),
    stop: (args) => coordinator.stop(args),
    result: (args) => coordinator.result(args),
    release: (args) => coordinator.release(args),
    waitEvent: (args, requestOptions = {}) => coordinator.waitEvent(args, requestOptions),
    close() { coordinator.close(); transport.close(); },
  });
}

function disabledRuntime({ workerMode, node, error }) {
  const code = String(error?.code || DEV_WORKER_FAILURE.TRANSPORT_FAILURE);
  const message = String(error?.message || 'Dev Worker transport is unavailable.');
  const fail = async () => {
    const failure = new Error(message);
    failure.code = code;
    throw failure;
  };
  return Object.freeze({
    role: workerMode ? 'worker' : 'supervisor',
    enabled: false,
    tabNodeId: node.tabNodeId,
    error: Object.freeze({ code, message }),
    discover: fail,
    claim: fail,
    createChat: fail,
    send: fail,
    observe: fail,
    followup: fail,
    nudge: fail,
    stop: fail,
    result: fail,
    release: fail,
    waitEvent: fail,
    close() {},
  });
}
