import { installChatGPTWebBridge } from './chatgpt-bridge.js';
import { installUserscriptNetworkBridge } from './network.js';

const PROVIDER_KEY = 'hex.ai.provider';
const host = document.getElementById('hex-userscript-host');
const bridge = installChatGPTWebBridge();

globalThis.__HEX_AI_PROVIDER__ = readProvider();
installUserscriptNetworkBridge();
const launcher = installLauncher();

/* The protected bootstrap has already installed the locally decrypted worker
   graph as memory-only Blob workers. Import the canonical app/UI unchanged so
   ChatGPT's CSP never enters Hex's binary-analysis data plane. */
(async () => {
  try {
    setLauncherState('Preparing Hex…', true);
    await import('../app.js');
    await import('../ux.js');
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
  (globalThis.__HEX_UI_ROOT__?.parentElement || document.documentElement).append(button);
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

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
