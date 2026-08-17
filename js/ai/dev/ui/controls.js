import { pick, isJa } from '../../../i18n.js';
import { menu } from '../../../ui.js';
import { uiButton } from '../../../ui/primitives.js';
import { SCOPE_ITEMS } from '../../ui/modes.js';
import { AGENT_PROFILE } from '../policy/agent-profile.js';
import { DEV_DECISION_POLICY } from '../policy/decision-policy.js';

const PROFILE_ITEMS = Object.freeze([
  { id: 'standard', ja: '標準', en: 'Standard' },
  { id: 'dev', ja: 'Dev', en: 'Dev' },
]);
const POLICY_ITEMS = Object.freeze([
  { id: DEV_DECISION_POLICY.NORMAL, ja: 'Normal', en: 'Normal' },
  { id: DEV_DECISION_POLICY.YOLO, ja: 'YOLO', en: 'YOLO' },
]);
const DEV_SCOPE_ITEMS = Object.freeze([
  { id: 'none', ja: 'なし', en: 'None' },
  ...SCOPE_ITEMS.filter((item) => item.id !== 'auto').map((item) => item.id === 'project'
    ? { ...item, ja: 'Hex 解析プロジェクト', en: 'Hex analysis project' }
    : item),
]);

export function installDevAgentControls({ panel, session, settings } = {}) {
  if (!panel?.root || !session || !settings) throw new TypeError('panel, session, and settings are required.');
  const contextBar = panel.root.querySelector('.ai-context-bar');
  const scopeChip = panel.root.querySelector('.ai-scope-chip');
  if (!contextBar || !scopeChip) throw new Error('Assistant context controls are unavailable.');

  const profile = segmented(PROFILE_ITEMS.filter((item) => settings.profiles().includes(item.id)), settings.agentProfile,
    (id) => { settings.setAgentProfile(id); panel.update({ stick: false }); }, pick('Agent 種別', 'Agent profile'));
  profile.classList.add('ai-agent-profile');
  const policy = segmented(POLICY_ITEMS, settings.decisionPolicy,
    (id) => { settings.setDecisionPolicy(id); panel.update({ stick: false }); }, pick('Dev 方針', 'Dev policy'));
  policy.classList.add('ai-dev-policy');
  contextBar.prepend(policy);
  contextBar.prepend(profile);

  const originalUpdate = panel.update.bind(panel);
  panel.update = (...args) => { const result = originalUpdate(...args); render(); return result; };
  const unsubscribeSettings = settings.on(() => render());
  const unsubscribeSession = session.on(() => queueMicrotask(render));

  const captureScope = (event) => {
    if (session.mode !== 'agent' || settings.agentProfile !== AGENT_PROFILE.DEV) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const rect = scopeChip.getBoundingClientRect();
    menu(DEV_SCOPE_ITEMS.map((item) => ({
      label: (isJa() ? item.ja : item.en) + (item.id === settings.analysisScope.initial ? ' ✓' : ''),
      action: () => { settings.setAnalysisScope(item.id); panel.update({ stick: false }); },
    })), rect.left + rect.width / 2, rect.bottom + 4);
  };
  scopeChip.addEventListener('click', captureScope, true);

  function render() {
    const inAgent = session.mode === 'agent';
    const inDev = inAgent && settings.agentProfile === AGENT_PROFILE.DEV;
    profile.hidden = !inAgent;
    policy.hidden = !inDev;
    for (const button of profile.querySelectorAll('.ai-seg')) setSelected(button, settings.agentProfile);
    for (const button of policy.querySelectorAll('.ai-seg')) setSelected(button, settings.decisionPolicy);
    if (inDev) scopeChip.textContent = pick('解析範囲: ', 'Analysis scope: ') + devScopeLabel(settings.analysisScope.initial);
    panel.root.dataset.agentProfile = inAgent ? settings.agentProfile : '';
    panel.root.dataset.decisionPolicy = inDev ? settings.decisionPolicy : '';
    panel.root.dataset.analysisScope = inDev ? settings.analysisScope.initial : session.scope;
  }
  render();

  return {
    settings,
    refresh: render,
    destroy() {
      unsubscribeSettings();
      unsubscribeSession();
      scopeChip.removeEventListener('click', captureScope, true);
      panel.update = originalUpdate;
      profile.remove();
      policy.remove();
    },
  };
}

function segmented(items, active, onPick, label) {
  const root = document.createElement('div');
  root.className = 'ai-segmented';
  root.setAttribute('role', 'tablist');
  root.setAttribute('aria-label', label);
  for (const item of items) {
    const button = uiButton(isJa() ? item.ja : item.en, { cls: 'ai-seg', onClick: () => onPick(item.id) });
    button.dataset.value = item.id;
    button.setAttribute('role', 'tab');
    setSelected(button, active);
    root.append(button);
  }
  return root;
}
function setSelected(button, active) { const selected = button.dataset.value === active; button.classList.toggle('active', selected); button.setAttribute('aria-selected', String(selected)); }
function devScopeLabel(id) { const item = DEV_SCOPE_ITEMS.find((candidate) => candidate.id === id) || DEV_SCOPE_ITEMS[0]; return isJa() ? item.ja : item.en; }
