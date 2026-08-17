import { DEV_WORKER_FAILURE } from '../../ai/dev/workers/contracts.js';
import { createTabNode, TAB_NODE_ROLE } from './tab-mesh/tab-node.js';
import { SingleConversationWorkerCoordinator } from './single-tab/single-conversation-worker-coordinator.js';
import { WorkerChatController } from './worker-host/worker-chat-controller.js';
import { createDevGithubReadRuntime } from './github-read-runtime.js';

export async function startParentDevWorkerRuntime(options = {}) {
  const node = createTabNode({ role: TAB_NODE_ROLE.SUPERVISOR, now: options.now });
  const github = options.github || createDevGithubReadRuntime({
    requestJson: options.githubRequestJson,
    now: options.now,
  });
  try {
    const controller = options.controller || new WorkerChatController({
      document: options.document || globalThis.document,
      adapter: options.adapter,
      router: options.router,
      turns: options.turns,
      now: options.now,
    });
    const coordinator = new SingleConversationWorkerCoordinator({
      controller,
      tabNodeId: node.tabNodeId,
      now: options.now,
    });
    return Object.freeze({
      role: 'supervisor',
      mode: 'single-tab-conversation-worker',
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
      verifyPullRequest: (args, requestOptions = {}) => github.verifyPullRequest(args, requestOptions),
      close() { coordinator.close(); },
    });
  } catch (error) {
    return disabledRuntime({ node, error, github });
  }
}

function disabledRuntime({ node, error, github }) {
  const code = String(error?.code || DEV_WORKER_FAILURE.PROVIDER_ERROR);
  const message = String(error?.message || 'Dev single-tab Worker runtime is unavailable.');
  const fail = async () => { const failure = new Error(message); failure.code = code; throw failure; };
  return Object.freeze({
    role: 'supervisor',
    mode: 'single-tab-conversation-worker',
    enabled: false,
    tabNodeId: node.tabNodeId,
    error: Object.freeze({ code, message }),
    discover: fail, claim: fail, createChat: fail, send: fail, observe: fail,
    followup: fail, nudge: fail, stop: fail, result: fail, release: fail, waitEvent: fail,
    verifyPullRequest: (args, requestOptions = {}) => github.verifyPullRequest(args, requestOptions),
    close() {},
  });
}
