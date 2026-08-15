import { installChatGPTWebBridge } from './chatgpt-bridge.js';
import { installUserscriptNetworkBridge } from './network.js';
import { prepareUserscriptWorkers } from './worker-assets.js';

const PROVIDER_KEY = 'hex.ai.provider';
const host = document.getElementById('hex-userscript-host');
const bridge = installChatGPTWebBridge();

globalThis.__HEX_AI_PROVIDER__ = readProvider();
installUserscriptNetworkBridge();
mirrorRootState();
const launcher = installLauncher();

/* The existing Hex application is left intact. Before importing app.js we
   preload the worker graph through GM.xmlHttpRequest and replace only the
   Worker constructor targets with same-origin blob URLs. That keeps ChatGPT's
   CSP out of Hex's binary-analysis data plane. */
(async () => {
  try {
    setLauncherState('Preparing Hex…', true);
    await prepareUserscriptWorkers();
    await import('../app.js');
    await import('../ux.js');
    installProviderControl();
    setLauncherState('HEX', false);
    await revealWhenReady();
  } catch (error) {
    console.error('[hex userscript] boot failed', error);
    launcher.hidden = false;
    launcher.disabled = false;
    launcher.textContent = 'Hex failed — tap for details';
    launcher.onclick = () => alert(`Hex failed to start:\n${error?.message || error}`);
  }
})();

function readProvider() {
  try { return localStorage.getItem(PROVIDER_KEY) === 'gemini' ? 'gemini' : 'chatgpt'; }
  catch { return 'chatgpt'; }
}

function writeProvider(value) {
  const provider = value === 'gemini' ? 'gemini' : 'chatgpt';
  globalThis.__HEX_AI_PROVIDER__ = provider;
  try { localStorage.setItem(PROVIDER_KEY, provider); } catch { /* private mode */ }
  return provider;
}

function installProviderControl() {
  if (!host || document.getElementById('hex-userscript-controls')) return;
  const titlebar = host.querySelector('.titlebar');
  if (!titlebar) return;

  const controls = document.createElement('div');
  controls.id = 'hex-userscript-controls';
  controls.className = 'hex-userscript-controls';

  const select = document.createElement('select');
  select.id = 'hex-ai-provider';
  select.className = 'hex-provider-select';
  select.setAttribute('aria-label', 'AI provider');
  select.append(new Option('ChatGPT Web', 'chatgpt'), new Option('Gemini 3.7 Flash', 'gemini'));
  select.value = globalThis.__HEX_AI_PROVIDER__;
  select.addEventListener('change', () => writeProvider(select.value));

  const chatgpt = document.createElement('button');
  chatgpt.type = 'button';
  chatgpt.className = 'tb-btn hex-host-toggle';
  chatgpt.textContent = 'ChatGPT';
  chatgpt.title = 'Show ChatGPT to change model or account';
  chatgpt.addEventListener('click', () => hideHex());

  controls.append(select, chatgpt);
  titlebar.append(controls);
}

function installLauncher() {
  let button = document.getElementById('hex-userscript-launcher');
  if (button) return button;
  button = document.createElement('button');
  button.id = 'hex-userscript-launcher';
  button.type = 'button';
  button.textContent = 'HEX';
  Object.assign(button.style, {
    position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483647',
    minWidth: '54px', minHeight: '44px', padding: '8px 12px', border: '0',
    borderRadius: '12px', background: '#111827', color: '#fff', fontWeight: '700',
    font: '600 13px/1.2 -apple-system,BlinkMacSystemFont,system-ui,sans-serif',
    boxShadow: '0 4px 18px rgba(0,0,0,.28)', cursor: 'pointer',
  });
  button.hidden = true;
  button.addEventListener('click', showHex);
  document.documentElement.append(button);
  return button;
}

function setLauncherState(text, busy) {
  launcher.textContent = text;
  launcher.disabled = !!busy;
  launcher.style.opacity = busy ? '0.72' : '1';
}

async function revealWhenReady() {
  if (!host) return;
  /* Keep login/model-picker UI accessible while ChatGPT itself is not ready.
     Gemini users can still open Hex manually from the launcher. */
  if (bridge.status().ready) { showHex(); return; }
  launcher.hidden = false;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(200);
    if (bridge.status().ready) { showHex(); return; }
  }
}

function showHex() {
  if (!host || launcher.disabled) return;
  host.style.visibility = 'visible';
  host.style.pointerEvents = 'auto';
  host.removeAttribute('aria-hidden');
  launcher.hidden = true;
}

function hideHex() {
  if (!host) return;
  host.style.visibility = 'hidden';
  host.style.pointerEvents = 'none';
  host.setAttribute('aria-hidden', 'true');
  launcher.hidden = false;
}

function mirrorRootState() {
  if (!host) return;
  const root = document.documentElement;
  const sync = () => {
    for (const cls of ['size-s', 'size-m', 'size-l', 'size-xl', 'sheet-open']) {
      host.classList.toggle(cls, root.classList.contains(cls));
    }
    const theme = root.getAttribute('data-theme');
    if (theme) host.setAttribute('data-theme', theme);
    else host.removeAttribute('data-theme');
    host.lang = root.lang || navigator.language || 'ja';
  };
  sync();
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ['class', 'data-theme', 'lang'] });
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
