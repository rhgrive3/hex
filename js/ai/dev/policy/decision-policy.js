export const DEV_DECISION_POLICY = Object.freeze({ NORMAL: 'normal', YOLO: 'yolo' });
export const DEV_DECISION_POLICIES = Object.freeze(Object.values(DEV_DECISION_POLICY));

export function assertDevDecisionPolicy(value) {
  const policy = String(value || '').toLowerCase();
  if (!DEV_DECISION_POLICIES.includes(policy)) throw new TypeError(`Unsupported Dev decision policy: ${value}`);
  return policy;
}

/**
 * Small policy contract for later Dev rounds. This describes decision authority;
 * it does not grant capabilities. Both policies may only use capabilities that
 * the current environment actually exposes, and either may voluntarily ask a
 * human for judgment.
 */
export function devDecisionPolicyContract(value) {
  const policy = assertDevDecisionPolicy(value);
  return Object.freeze({
    policy,
    ordinaryEngineering: 'autonomous',
    securityOrPermissionBoundary: policy === DEV_DECISION_POLICY.NORMAL ? 'human-confirmation-normally' : 'autonomous',
    availableCapabilitiesOnly: true,
    mayAskHuman: true,
  });
}
