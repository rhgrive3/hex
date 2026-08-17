import { buildDevWorkerInstruction } from './contracts.js';

export const DEV_WORKER_TOOL = Object.freeze({
  DISCOVER: 'worker.discover',
  CLAIM: 'worker.claim',
  CREATE_CHAT: 'worker.create_chat',
  SEND: 'worker.send',
  OBSERVE: 'worker.observe',
  FOLLOWUP: 'worker.followup',
  NUDGE: 'worker.nudge',
  STOP: 'worker.stop',
  RESULT: 'worker.result',
  RELEASE: 'worker.release',
});
export const DEV_WORKER_TOOLS = Object.freeze(Object.values(DEV_WORKER_TOOL));

export function createDevWorkerToolSurface(client) {
  if (!client || typeof client !== 'object' || client.enabled === false) return null;
  const required = [
    'discover', 'claim', 'createChat', 'send', 'observe', 'followup',
    'nudge', 'stop', 'result', 'release', 'waitEvent',
  ];
  if (required.some((name) => typeof client[name] !== 'function')) return null;

  const fullTurnOptions = Object.freeze({ timeoutMs: 0 });
  const handlers = new Map([
    [DEV_WORKER_TOOL.DISCOVER, (args) => client.discover(args)],
    [DEV_WORKER_TOOL.CLAIM, (args) => client.claim(args)],
    [DEV_WORKER_TOOL.CREATE_CHAT, (args) => client.createChat(args)],
    [DEV_WORKER_TOOL.SEND, (args = {}) => client.send({
      ...args,
      instruction: buildDevWorkerInstruction(args.instruction),
    }, fullTurnOptions)],
    [DEV_WORKER_TOOL.OBSERVE, (args) => client.observe(args)],
    [DEV_WORKER_TOOL.FOLLOWUP, (args) => client.followup(args, fullTurnOptions)],
    [DEV_WORKER_TOOL.NUDGE, (args) => client.nudge(args, fullTurnOptions)],
    [DEV_WORKER_TOOL.STOP, (args) => client.stop(args)],
    [DEV_WORKER_TOOL.RESULT, (args) => client.result(args)],
    [DEV_WORKER_TOOL.RELEASE, (args) => client.release(args)],
  ]);

  return Object.freeze({
    toolNames: DEV_WORKER_TOOLS,
    has(name) {
      return handlers.has(String(name || ''));
    },
    execute(name, args = {}) {
      const handler = handlers.get(String(name || ''));
      if (!handler) throw new TypeError(`Unavailable Dev Worker tool: ${name}`);
      return handler(args);
    },
    waitEvent(events, options = {}) {
      return client.waitEvent({ events, runId: options.runId ?? null }, options);
    },
  });
}
