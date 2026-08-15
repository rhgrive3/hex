const ALLOWED_HUMAN_ONLY_PREFIXES = Object.freeze([
  'browser-security-user-gesture:', 'external-os-facility-unavailable:', 'inherently-visual-only-setting:',
]);

export function auditCapabilityParity(entries) {
  const failures = [];
  const ids = new Set();
  for (const entry of entries || []) {
    if (!entry?.id || ids.has(entry.id)) { failures.push({ id: entry?.id || null, reason: 'missing-or-duplicate-id' }); continue; }
    ids.add(entry.id);
    if (entry.agentExposed) {
      if (!entry.agentTool && !entry.actionKind && entry.category === 'analysis') failures.push({ id: entry.id, reason: 'missing-agent-analysis-adapter' });
      continue;
    }
    const reason = String(entry.humanOnlyReason || '');
    if (!ALLOWED_HUMAN_ONLY_PREFIXES.some((prefix) => reason.startsWith(prefix))) failures.push({ id: entry.id, reason: 'invalid-human-only-reason' });
  }
  return { ok: failures.length === 0, failures, checked: ids.size };
}

export function assertCapabilityParity(entries) {
  const result = auditCapabilityParity(entries);
  if (!result.ok) throw new Error(`Human/agent capability parity failed: ${result.failures.map((item) => `${item.id}:${item.reason}`).join(', ')}`);
  return result;
}
