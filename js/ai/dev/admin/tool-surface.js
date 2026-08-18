export const DEV_ADMIN_TOOL = Object.freeze({
  PAGE_SNAPSHOT: 'chatgpt.page.snapshot',
  PAGE_SCRIPTS: 'chatgpt.page.scripts',
  PAGE_SCRIPT_SOURCE: 'chatgpt.page.script_source',
});
export const DEV_ADMIN_TOOLS = Object.freeze(Object.values(DEV_ADMIN_TOOL));

export function createDevAdminToolSurface(client) {
  if (!client || typeof client !== 'object' || client.enabled === false) return null;
  const required = ['pageSnapshot', 'pageScripts', 'pageScriptSource'];
  if (required.some((name) => typeof client[name] !== 'function')) return null;
  const handlers = new Map([
    [DEV_ADMIN_TOOL.PAGE_SNAPSHOT, (args) => client.pageSnapshot(args)],
    [DEV_ADMIN_TOOL.PAGE_SCRIPTS, (args) => client.pageScripts(args)],
    [DEV_ADMIN_TOOL.PAGE_SCRIPT_SOURCE, (args) => client.pageScriptSource(args)],
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
