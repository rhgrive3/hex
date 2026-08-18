import { DEV_RUNTIME_IDENTITY_TOOL } from '../bootstrap/self-update-gate.js';

export const DEV_ADMIN_TOOL = Object.freeze({
  RUNTIME_IDENTITY: DEV_RUNTIME_IDENTITY_TOOL,
  PAGE_SNAPSHOT: 'chatgpt.page.snapshot',
  PAGE_SCRIPTS: 'chatgpt.page.scripts',
  PAGE_SCRIPT_SOURCE: 'chatgpt.page.script_source',
  SKILL_LIST: 'chatgpt.skill.list',
  SKILL_DESCRIBE: 'chatgpt.skill.describe',
  SKILL_INSTALL_CANDIDATE: 'chatgpt.skill.install_candidate',
  SKILL_VALIDATE_CANDIDATE: 'chatgpt.skill.validate_candidate',
  SKILL_ACTIVATE: 'chatgpt.skill.activate',
  SKILL_ROLLBACK: 'chatgpt.skill.rollback',
  SKILL_RUN: 'chatgpt.skill.run',
  POOL_STATUS: 'worker.pool.status',
  POOL_PROVISION: 'worker.pool.provision',
  POOL_CLAIM: 'worker.pool.claim',
  POOL_CREATE_CHAT: 'worker.pool.create_chat',
  POOL_START: 'worker.pool.start',
  POOL_OBSERVE: 'worker.pool.observe',
  POOL_RESULT: 'worker.pool.result',
  POOL_FOLLOWUP: 'worker.pool.followup',
  POOL_NUDGE: 'worker.pool.nudge',
  POOL_STOP: 'worker.pool.stop',
  POOL_RELEASE: 'worker.pool.release',
  GRAPH_START: 'worker.graph.start',
  GRAPH_STATUS: 'worker.graph.status',
  GRAPH_TASK_RESULT: 'worker.graph.task_result',
  GRAPH_CANCEL: 'worker.graph.cancel',
});
export const DEV_ADMIN_TOOLS = Object.freeze(Object.values(DEV_ADMIN_TOOL));

export function createDevAdminToolSurface(client) {
  if (!client || typeof client !== 'object' || client.enabled === false) return null;
  const handlers = new Map();
  for (const [tool, method] of [
    [DEV_ADMIN_TOOL.RUNTIME_IDENTITY,'runtimeIdentity'],
    [DEV_ADMIN_TOOL.PAGE_SNAPSHOT,'pageSnapshot'], [DEV_ADMIN_TOOL.PAGE_SCRIPTS,'pageScripts'], [DEV_ADMIN_TOOL.PAGE_SCRIPT_SOURCE,'pageScriptSource'],
    [DEV_ADMIN_TOOL.SKILL_LIST,'skillList'], [DEV_ADMIN_TOOL.SKILL_DESCRIBE,'skillDescribe'], [DEV_ADMIN_TOOL.SKILL_INSTALL_CANDIDATE,'skillInstallCandidate'], [DEV_ADMIN_TOOL.SKILL_VALIDATE_CANDIDATE,'skillValidateCandidate'], [DEV_ADMIN_TOOL.SKILL_ACTIVATE,'skillActivate'], [DEV_ADMIN_TOOL.SKILL_ROLLBACK,'skillRollback'], [DEV_ADMIN_TOOL.SKILL_RUN,'skillRun'],
    [DEV_ADMIN_TOOL.POOL_STATUS,'poolStatus'], [DEV_ADMIN_TOOL.POOL_PROVISION,'poolProvision'], [DEV_ADMIN_TOOL.POOL_CLAIM,'poolClaim'], [DEV_ADMIN_TOOL.POOL_CREATE_CHAT,'poolCreateChat'], [DEV_ADMIN_TOOL.POOL_START,'poolStart'], [DEV_ADMIN_TOOL.POOL_OBSERVE,'poolObserve'], [DEV_ADMIN_TOOL.POOL_RESULT,'poolResult'], [DEV_ADMIN_TOOL.POOL_FOLLOWUP,'poolFollowup'], [DEV_ADMIN_TOOL.POOL_NUDGE,'poolNudge'], [DEV_ADMIN_TOOL.POOL_STOP,'poolStop'], [DEV_ADMIN_TOOL.POOL_RELEASE,'poolRelease'],
    [DEV_ADMIN_TOOL.GRAPH_START,'graphStart'], [DEV_ADMIN_TOOL.GRAPH_STATUS,'graphStatus'], [DEV_ADMIN_TOOL.GRAPH_TASK_RESULT,'graphTaskResult'], [DEV_ADMIN_TOOL.GRAPH_CANCEL,'graphCancel'],
  ]) register(handlers, client, tool, method);
  if (!handlers.size) return null;
  return Object.freeze({
    toolNames: Object.freeze([...handlers.keys()]),
    has(name) { return handlers.has(String(name || '')); },
    execute(name, args = {}) {
      const handler = handlers.get(String(name || ''));
      if (!handler) throw new TypeError(`Unavailable Dev Admin tool: ${name}`);
      return handler(args);
    },
  });
}
function register(handlers, client, tool, method) { if (typeof client?.[method] === 'function') handlers.set(tool, (args) => client[method](args || {})); }
