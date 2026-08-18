export const TAB_NODE_ROLE = Object.freeze({
  SUPERVISOR: 'supervisor',
  WORKER: 'worker',
  AVAILABLE: 'available',
});
export const TAB_NODE_ROLES = Object.freeze(Object.values(TAB_NODE_ROLE));

export function createTabNode({
  role = TAB_NODE_ROLE.SUPERVISOR,
  runId = null,
  workerId = null,
  chatgptConversationId = null,
  chatgptProjectIdentity = null,
  now = () => new Date().toISOString(),
  idFactory = createSecureId,
} = {}) {
  if (!TAB_NODE_ROLES.includes(role)) {
    throw new TypeError(`Unsupported TabNode role: ${role}`);
  }
  return Object.freeze({
    tabNodeId: idFactory('tab'),
    role,
    runId: nullable(runId),
    workerId: nullable(workerId),
    chatgptConversationId: nullable(chatgptConversationId),
    chatgptProjectIdentity: nullable(chatgptProjectIdentity),
    lastHeartbeat: timestamp(now()),
  });
}

export function updateTabNode(node, patch = {}, { now = () => new Date().toISOString() } = {}) {
  if (!node?.tabNodeId) throw new TypeError('A TabNode is required.');
  const role = patch.role ?? node.role;
  if (!TAB_NODE_ROLES.includes(role)) {
    throw new TypeError(`Unsupported TabNode role: ${role}`);
  }
  return Object.freeze({
    tabNodeId: String(node.tabNodeId),
    role,
    runId: patch.runId === undefined ? node.runId : nullable(patch.runId),
    workerId: patch.workerId === undefined ? node.workerId : nullable(patch.workerId),
    chatgptConversationId: patch.chatgptConversationId === undefined
      ? node.chatgptConversationId
      : nullable(patch.chatgptConversationId),
    chatgptProjectIdentity: patch.chatgptProjectIdentity === undefined
      ? node.chatgptProjectIdentity
      : nullable(patch.chatgptProjectIdentity),
    lastHeartbeat: timestamp(patch.lastHeartbeat || now()),
  });
}

export function createSecureId(prefix = 'id', cryptoRef = globalThis.crypto) {
  if (!cryptoRef || typeof cryptoRef.getRandomValues !== 'function') {
    throw new Error('Secure crypto is required for Hex tab identity.');
  }
  const bytes = new Uint8Array(16);
  cryptoRef.getRandomValues(bytes);
  const normalizedPrefix = String(prefix).replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return `${normalizedPrefix}-${hex(bytes)}`;
}

function hex(bytes) {
  let out = '';
  for (const value of bytes) out += value.toString(16).padStart(2, '0');
  return out;
}

function nullable(value) {
  return value == null || value === '' ? null : String(value);
}

function timestamp(value) {
  const text = String(value);
  if (!Number.isFinite(Date.parse(text))) throw new TypeError(`Invalid timestamp: ${value}`);
  return text;
}
