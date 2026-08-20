import {
  DEV_TOOL_SURFACE,
  devToolContractsForSurface,
} from '../protocol/dev-tool-contracts.js';

const ADMIN_CONTRACTS = devToolContractsForSurface(DEV_TOOL_SURFACE.ADMIN);

/* Names and client-method mapping both come from the canonical registry, so a
   tool cannot be exposed here without the prompt contract, operation class and
   owner that the registry requires it to declare. */
export const DEV_ADMIN_TOOL = Object.freeze(Object.fromEntries(
  ADMIN_CONTRACTS.map((contract) => [adminConstantName(contract.publicName), contract.publicName]),
));
export const DEV_ADMIN_TOOLS = Object.freeze(ADMIN_CONTRACTS.map((contract) => contract.publicName));

export function createDevAdminToolSurface(client) {
  if (!client || typeof client !== 'object' || client.enabled === false) return null;
  const handlers = new Map();
  for (const contract of ADMIN_CONTRACTS) register(handlers, client, contract.publicName, contract.clientMethod);
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

/* dev.runtime.identity -> RUNTIME_IDENTITY, worker.pool.create_chat -> POOL_CREATE_CHAT.
   The historic constant names drop the leading namespace segment. */
function adminConstantName(publicName) {
  const parts = String(publicName).split('.');
  const named = parts.length > 2 ? parts.slice(1) : parts;
  return named.join('_').toUpperCase();
}
function register(handlers, client, tool, method) { if (typeof client?.[method] === 'function') handlers.set(tool, (args) => client[method](args || {})); }
