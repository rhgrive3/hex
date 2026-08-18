export const DEV_ADMIN_TOOL = Object.freeze({
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
});
export const DEV_ADMIN_TOOLS = Object.freeze(Object.values(DEV_ADMIN_TOOL));

export function createDevAdminToolSurface(client) {
  if (!client || typeof client !== 'object' || client.enabled === false) return null;
  const handlers = new Map();
  register(handlers, client, DEV_ADMIN_TOOL.PAGE_SNAPSHOT, 'pageSnapshot');
  register(handlers, client, DEV_ADMIN_TOOL.PAGE_SCRIPTS, 'pageScripts');
  register(handlers, client, DEV_ADMIN_TOOL.PAGE_SCRIPT_SOURCE, 'pageScriptSource');
  register(handlers, client, DEV_ADMIN_TOOL.SKILL_LIST, 'skillList');
  register(handlers, client, DEV_ADMIN_TOOL.SKILL_DESCRIBE, 'skillDescribe');
  register(handlers, client, DEV_ADMIN_TOOL.SKILL_INSTALL_CANDIDATE, 'skillInstallCandidate');
  register(handlers, client, DEV_ADMIN_TOOL.SKILL_VALIDATE_CANDIDATE, 'skillValidateCandidate');
  register(handlers, client, DEV_ADMIN_TOOL.SKILL_ACTIVATE, 'skillActivate');
  register(handlers, client, DEV_ADMIN_TOOL.SKILL_ROLLBACK, 'skillRollback');
  register(handlers, client, DEV_ADMIN_TOOL.SKILL_RUN, 'skillRun');
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

function register(handlers, client, tool, method) {
  if (typeof client?.[method] !== 'function') return;
  handlers.set(tool, (args) => client[method](args || {}));
}
