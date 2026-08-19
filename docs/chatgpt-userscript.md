# Hex on ChatGPT Web

Hex runs on `https://chatgpt.com/*` as a thin userscript loader. The loader does not contain the Hex application, analysis engines, agent tools, workers, or CSS. It bootstraps a protected, versioned runtime and then keeps all binary-analysis hot paths in browser memory.

## Runtime architecture

```text
chatgpt.com
  └─ 5–64 KiB userscript loader
      └─ POST /runtime/bootstrap (nonce + build + ECDH public key)
          └─ signed, short-lived, one-use runtime session + wrapped key
              └─ encrypted/minified runtime → WebCrypto verify/decrypt → Blob URL
                  └─ canonical Hex UI / AIRuntime / local workers
                      ├─ ChatGPT Web → visible DOM adapter
                      └─ Worker-backed provider → server-held API credentials
```

The build resolves the canonical CSS import graph, bundles and minifies the application with identifier mangling, embeds the local Worker/WASM graph, gzip-compresses it, and encrypts it with AES-256-GCM. Source maps are disabled. The content key and signing key are generated into `.runtime-build/`, outside `dist/`, and are bundled into the Cloudflare Worker rather than the public loader or static assets.

Client-side decryption cannot make source cryptographically secret from the person running the client. The protection goal is narrower: raw source is not deployed, casual/direct inspection is prevented, bulk scraping costs more, and accidental repository exposure is blocked.

## Deployment boundary

`wrangler.jsonc` publishes only `dist/`; the repository root is never a Static Assets directory. `run_worker_first` is enabled for every route. Raw `/js/*`, `/css/*`, `/scripts/*`, `/tests/*`, configuration files, the userscript template, old `/userscript-assets/*`, and the private ciphertext path return 404 unless reached by the authenticated runtime handler.

```sh
npm ci
npm run userscript:test
npx wrangler deploy
```

The build produces:

- `dist/index.html` and a tiny standalone bootstrap loader;
- `dist/userscript/hex.user.template.js`, served only as `/hex.user.js` or metadata-only `/hex.meta.js`;
- `dist/.runtime/runtime.<buildId>.bin`, reachable only through a valid one-use session;
- `.runtime-build/runtime-secrets.js`, a server bundle input that is never deployed as a static asset.

Install `https://ida.rhgrive.workers.dev/hex.user.js`.

## Bootstrap and integrity

The loader creates an ephemeral P-256 ECDH key pair and submits a nonce, loader version, expected build ID, request ID, session identity, and public JWK. `RuntimeBootstrap` rejects reused nonces. The Worker returns a two-minute HMAC-signed session, immutable manifest, protected locator, ephemeral server public key, and an ECDH/HKDF-derived AES-GCM key envelope. The ciphertext route verifies signature, expiry, build, request identity, and consumes the session once.

The loader verifies the ciphertext SHA-256, unwraps the content key, performs authenticated AES-GCM decryption with manifest AAD, decompresses gzip, verifies the plaintext SHA-256, and executes through a temporary Blob URL. It never falls back to plaintext and does not store decrypted runtime bytes in localStorage, IndexedDB, or Cache Storage. Buffers are cleared and the Blob URL is revoked after module evaluation.

Origin and Referer checks are supplementary controls only; session signatures, expiry, build binding, ECDH key possession, and replay state form the authorization boundary.

## ChatGPT DOM provider

Selectors live in `js/userscript/chatgpt-selectors.js`. `ChatGPTDOMAdapter`, `ChatGPTConversationRouter`, `ChatGPTModelController`, and `ChatGPTTurnController` separately own DOM access, Hex-session/ChatGPT-URL routing, dynamic model selection, and turn completion.

For the normal AI bridge, one ChatGPT conversation DOM permits one in-flight Hex request at a time. Completion requires a new assistant-turn identity, a matching submitted user turn, non-empty stable content, a DOM quiet period, and a stopped generating state. Errors, cancellation, navigation, multiple new turns, manual interference, and timeout are explicit failures; an old assistant turn is never returned.

This per-conversation rule must not be confused with the **Dev Agent Worker Pool**. The Dev Agent may host up to six same-origin hidden Worker iframes inside one Supervisor tab, with each iframe owning a separate ChatGPT conversation/turn controller. Each Worker still obeys its own one-in-flight turn rule. The canonical Dev Agent topology and target-platform constraints live in `improving-agent.md`.

Available model/reasoning choices are discovered from the visible picker. Canonical IDs such as `chatgpt-web/sol`, `chatgpt-web/terra`, and `chatgpt-web/luna` are exposed only when matching UI options are observed. A requested model and reasoning level are re-read after selection; mismatch fails closed without fallback.

Each Hex `conversationId` binds to an AIRuntime session, and each AIRuntime/Hex session key binds to a ChatGPT `/c/<id>` URL. Switching A → B → A restores both layers independently. ChatGPT history provides reasoning continuity only; Hex EvidenceStore and deterministic tools remain truth.

The bridge never reads cookies/tokens, calls undocumented ChatGPT APIs, or implements Cloudflare/Sentinel/Turnstile bypasses.

## Host UI isolation

The userscript and standalone site use the same application and CSS. In the userscript, the fully resolved stylesheet is wrapped in `@scope (#hex-userscript-host)`. `uiRoot()` owns product readiness, AI/keyboard/sheet state, size classes, theme, language, and CSS variables on the Hex host instead of `chatgpt.com`'s `<html>`. Provider/model controls belong to the AI panel contract; there is no userscript-only title-bar picker.
