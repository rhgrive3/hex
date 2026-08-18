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
  const required = [
    'pageSnapshot', 'pageScripts', 'pageScriptSource',
    'skillList', 'skillDescribe', 'skillInstallCandidate', 'skillValidateCandidate', 'skillActivate', 'skillRollback', 'skillRun',
  ];
  if (required.some((name) => typeof client[name] !== 'function')) return null;
  const handlers = new Map([
    [DEV_ADMIN_TOOL.PAGE_SNAPSHOT, (args) => client.pageSnapshot(args)],
    [DEV_ADMIN_TOOL.PAGE_SCRIPTS, (args) => client.pageScripts(args)],
    [DEV_ADMIN_TOOL.PAGE_SCRIPT_SOURCE, (args) => client.pageScriptSource(args)],
    [DEV_ADMIN_TOOL.SKILL_LIST, () => client.skillList()],
    [DEV_ADMIN_TOOL.SKILL_DESCRIBE, (args) => client.skillDescribe(args)],
    [DEV_ADMIN_TOOL.SKILL_INSTALL_CANDIDATE, (args) => client.skillInstallCandidate(args)],
    [DEV_ADMIN_TOOL.SKILL_VALIDATE_CANDIDATE, (args) => client.skillValidateCandidate(args)],
    [DEV_ADMIN_TOOL.SKILL_ACTIVATE, (args) => client.skillActivate(args)],
    [DEV_ADMIN_TOOL.SKILL_ROLLBACK, (args) => client.skillRollback(args)],
    [DEV_ADMIN_TOOL.SKILL_RUN, (args) => client.skillRun(args)],
  ]);
  return Object.freeze({
    toolNames: DEV_ADMIN_TOOLS,
    has(name) { return handlers.has(String(name || '')); },
    execute(name, args = {}) {
      const handler = handlers.get(String(name || ''));
      if (!handler) throw new TypeError(`Unavailable Dev Admin tool: ${name}`);
      return handler(args);
    },
  });
}
