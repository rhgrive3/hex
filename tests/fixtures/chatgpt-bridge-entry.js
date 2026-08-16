/*
 * Browser entry for the production-DOM regression suite. It wires the real
 * production topology inside one page: the ChatGPT Web bridge behind the
 * ChatGPT parent RPC server, reached through the embed bridge proxy over a real
 * MessagePort. A result that cannot survive structured clone, or that the RPC
 * sanitizer refuses, fails here exactly as it would in the userscript.
 */
import { installChatGPTWebBridge } from '../../js/userscript/chatgpt-bridge.js';
import { createChatGPTParentRpc } from '../../js/userscript/chatgpt-parent-rpc.js';
import { createEmbedBridgeProxy } from '../../js/userscript/embed-bridge-proxy.js';

globalThis.__HEX_RUN__ = async function run(input) {
  globalThis.__CHATGPT__.configure(input.chatgpt);
  const storage = memoryStorage();
  if (input.seed?.length) {
    globalThis.__CHATGPT__.seedHistory(input.seed, input.chatgpt.conversationId);
    storage.setItem('hex.chatgpt.conversations.v1', JSON.stringify({
      'hex-production-dom': { id: input.chatgpt.conversationId, url: `https://chatgpt.com/c/${input.chatgpt.conversationId}` },
    }));
  }

  delete globalThis.__HEX_CHATGPT_BRIDGE__;
  const bridge = installChatGPTWebBridge({
    quietMs: 120, pollMs: 20, startTimeoutMs: 3000, conversationGraceMs: 200, storage,
  });
  const channel = new MessageChannel();
  const parent = createChatGPTParentRpc({ port: channel.port1, bridge });
  const proxy = createEmbedBridgeProxy({ port: channel.port2 });

  try {
    const value = await proxy.request(input.prompt, { sessionKey: 'hex-production-dom', timeoutMs: 12000 });
    return { ok: true, value };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error?.code || null,
        stage: error?.details?.stage || null,
        message: String(error?.message || error),
      },
    };
  } finally {
    proxy.close();
    parent.close();
  }
};

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}
