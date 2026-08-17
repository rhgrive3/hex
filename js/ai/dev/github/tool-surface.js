export const DEV_GITHUB_TOOL = Object.freeze({
  VERIFY_PR: 'github.verify_pr',
});
export const DEV_GITHUB_TOOLS = Object.freeze(Object.values(DEV_GITHUB_TOOL));

export function createDevGithubToolSurface(client) {
  if (!client || typeof client.verifyPullRequest !== 'function') return null;
  const handlers = new Map([
    [DEV_GITHUB_TOOL.VERIFY_PR, (args = {}) => client.verifyPullRequest(args)],
  ]);
  return Object.freeze({
    toolNames: DEV_GITHUB_TOOLS,
    has(name) { return handlers.has(String(name || '')); },
    execute(name, args = {}) {
      const handler = handlers.get(String(name || ''));
      if (!handler) throw new TypeError(`Unavailable Dev GitHub tool: ${name}`);
      return handler(args);
    },
  });
}
