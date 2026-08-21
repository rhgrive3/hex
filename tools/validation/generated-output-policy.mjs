/*
 * Generated userscript ownership is a transaction boundary. Component lanes
 * build the outputs ephemerally; only the main/integration lane may publish
 * the committed projection. Keep this decision in one small, testable policy
 * so workflow jobs cannot accidentally turn a component into a release lane.
 */

export const GENERATED_OUTPUT_MODE = Object.freeze({
  ENFORCE: 'enforce',
  EPHEMERAL: 'ephemeral',
});

const COMPONENT_PREFIX = 'dev-agent-hardening/';
const INTEGRATION_PREFIX = 'dev-agent-hardening/integration/';

export function generatedOutputMode({ eventName = '', headRef = '', ref = '' } = {}) {
  const event = String(eventName || '');
  const branch = String(headRef || '');
  const refName = String(ref || '');

  if (event === 'pull_request'
    && branch.startsWith(COMPONENT_PREFIX)
    && !branch.startsWith(INTEGRATION_PREFIX)) {
    return GENERATED_OUTPUT_MODE.EPHEMERAL;
  }

  // Pushes to main, integration/release branches, workflow dispatch, and
  // unknown contexts fail closed to canonical generated-output enforcement.
  // A component lane opts into the exemption only by its explicit prefix.
  void refName;
  return GENERATED_OUTPUT_MODE.ENFORCE;
}

export function shouldEnforceGeneratedOutput(context = {}) {
  return generatedOutputMode(context) === GENERATED_OUTPUT_MODE.ENFORCE;
}

const isMain = process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname;
if (isMain) {
  const mode = generatedOutputMode({
    eventName: process.env.GITHUB_EVENT_NAME,
    headRef: process.env.GITHUB_HEAD_REF,
    ref: process.env.GITHUB_REF,
  });
  process.stdout.write(`${mode}\n`);
}
