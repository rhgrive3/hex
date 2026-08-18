const MAX_DETAIL_TEXT = 180;
const DIAGNOSTIC_KEY = '__HEX_DEV_BOOTSTRAP_DIAGNOSTIC__';

export function bootstrapStatusPresentation(status, { ja = false } = {}) {
  const value = status && typeof status === 'object' ? status : { state: 'unknown' };
  const state = clean(value.state) || 'unknown';
  const identity = value.identity && typeof value.identity === 'object' ? value.identity : {};
  const commit = clean(identity.commit);
  const buildId = clean(identity.buildId);
  const extensionVersion = clean(value.extensionVersion);
  const integrity = clean(value.integrity);
  const capability = clean(value.capability);
  const proofAnswer = compact(value.proofAnswer, MAX_DETAIL_TEXT);
  const error = compact(value.error, MAX_DETAIL_TEXT);
  const proofVerified = state === 'complete' && !!capability;

  if (state === 'skipped') {
    return freeze({ visible: false, state, summary: '', detail: '', commit, buildId, extensionVersion, integrity, capability, proofVerified, error });
  }

  const summary = summaryFor(state, ja);
  const fields = [];
  if (commit) fields.push(`commit: ${commit}`);
  if (buildId) fields.push(`buildId: ${buildId}`);
  if (extensionVersion) fields.push(`extension: v${extensionVersion}`);
  if (integrity) fields.push(`integrity: ${integrity}`);
  if (capability) fields.push(`capability: ${capability}`);
  if (proofVerified) fields.push(ja ? 'proof: 検証済み' : 'proof: verified');
  if (proofAnswer) fields.push(`answer: ${proofAnswer}`);
  if (error) fields.push(`error: ${error}`);

  return freeze({
    visible: true,
    state,
    summary,
    detail: fields.length ? `${summary} · ${fields.join(' · ')}` : summary,
    commit,
    buildId,
    extensionVersion,
    integrity,
    capability,
    proofVerified,
    error,
  });
}

export function publishBootstrapDiagnostic(globalObject, status) {
  const target = globalObject || globalThis;
  let diagnostic = target?.[DIAGNOSTIC_KEY] || null;
  if (!diagnostic) {
    const documentRef = target?.document;
    const root = documentRef?.getElementById?.('ai-panel') || null;
    const ja = languageOf(target).startsWith('ja');
    diagnostic = installBootstrapDiagnostic({ panel: root ? { root } : null, ja, documentRef });
    try { target[DIAGNOSTIC_KEY] = diagnostic; } catch {}
  }
  return diagnostic.set(status);
}

export function installBootstrapDiagnostic({ panel, ja = false, documentRef = globalThis.document } = {}) {
  const root = panel?.root;
  const contextBar = root?.querySelector?.('.ai-context-bar');
  if (!root || !contextBar || !documentRef?.createElement) return noOpDiagnostic(ja);

  const chip = documentRef.createElement('button');
  chip.id = 'ai-bootstrap-status';
  chip.type = 'button';
  chip.className = 'ai-chip ai-bootstrap-chip';
  chip.hidden = true;
  chip.setAttribute('aria-live', 'polite');
  chip.setAttribute('aria-label', ja ? 'Round 4 Bootstrap 状態' : 'Round 4 Bootstrap status');
  contextBar.append(chip);

  let current = bootstrapStatusPresentation({ state: 'skipped' }, { ja });
  let expanded = false;

  const render = () => {
    chip.hidden = !current.visible;
    chip.dataset.state = current.state;
    chip.textContent = expanded ? current.detail : current.summary;
    chip.title = current.detail;
    chip.setAttribute('aria-expanded', String(expanded));

    setDataset(root, 'bootstrapState', current.state);
    setDataset(root, 'bootstrapCommit', current.commit);
    setDataset(root, 'bootstrapBuildId', current.buildId);
    setDataset(root, 'bootstrapExtensionVersion', current.extensionVersion);
    setDataset(root, 'bootstrapIntegrity', current.integrity);
    setDataset(root, 'bootstrapCapability', current.capability);
    setDataset(root, 'bootstrapProof', current.proofVerified ? 'verified' : '');
    setDataset(root, 'bootstrapError', current.error);
  };

  chip.addEventListener('click', () => {
    if (!current.visible) return;
    expanded = !expanded;
    render();
  });

  render();
  return Object.freeze({
    set(status) {
      current = bootstrapStatusPresentation(status, { ja });
      expanded = current.state === 'failed';
      render();
      return current;
    },
    current() { return current; },
    element: chip,
    destroy() { chip.remove(); },
  });
}

function summaryFor(state, ja) {
  if (state === 'running') return ja ? 'R4 … Bootstrap 確認中' : 'R4 … Bootstrap checking';
  if (state === 'reload-requested') return ja ? 'R4 ↻ Bootstrap 再初期化' : 'R4 ↻ Bootstrap reinitializing';
  if (state === 'complete') return ja ? 'R4 ✓ Bootstrap 完了' : 'R4 ✓ Bootstrap complete';
  if (state === 'failed') return ja ? 'R4 ✕ Bootstrap 失敗' : 'R4 ✕ Bootstrap failed';
  return `R4 ? Bootstrap ${state}`;
}

function languageOf(globalObject) {
  const documentLanguage = clean(globalObject?.document?.documentElement?.lang).toLowerCase();
  if (documentLanguage) return documentLanguage;
  return clean(globalObject?.navigator?.language).toLowerCase();
}

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function compact(value, maxLength) {
  const text = clean(value).replace(/\s+/g, ' ');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function setDataset(root, key, value) {
  if (!root?.dataset) return;
  if (value) root.dataset[key] = String(value);
  else delete root.dataset[key];
}

function noOpDiagnostic(ja = false) {
  let current = bootstrapStatusPresentation({ state: 'skipped' }, { ja });
  return Object.freeze({
    set(status) { current = bootstrapStatusPresentation(status, { ja }); return current; },
    current() { return current; },
    element: null,
    destroy() {},
  });
}

function freeze(value) {
  return Object.freeze({ ...value });
}
