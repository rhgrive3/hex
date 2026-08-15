# Hex on ChatGPT Web

Hex can run as a full-screen userscript on `https://chatgpt.com/*` without duplicating the application or moving the binary-analysis backend out of the browser.

## Architecture

```text
chatgpt.com
  └─ Hex userscript host
      └─ existing Hex app / AIRuntime / deterministic tools
          ├─ ChatGPT Web (default) -> DOM bridge -> selected ChatGPT model
          └─ Gemini 3.7 Flash -> ida Worker -> Gemini API
```

ChatGPT Web is a planner/explainer only. Hex still executes every deterministic analysis tool, validates model decisions, owns evidence, and enforces investigation scope.

The ChatGPT bridge does not read cookies, access tokens, internal ChatGPT API endpoints, Sentinel/Turnstile data, or browser credentials. It uses the visible ChatGPT composer, send/stop controls, and assistant turns.

## Build and deploy

The Cloudflare Worker name remains `ida` in `wrangler.jsonc`.

```sh
npm ci
npm run userscript:test
npx wrangler deploy
```

Wrangler runs `npm run userscript:build` before deployment. The generated deployment files are also committed and checked by CI:

- `userscript/hex.user.template.js`
- `userscript/platform-worker.bundle.js`

The Worker serves:

- `/hex.user.js` — installable userscript with the deployed origin substituted into the template
- `/hex.meta.js` — lightweight update metadata
- `/userscript-assets/*` — Hex Worker/WASM assets consumed by the userscript transport
- `/api/*` — existing Hex backend routes

Install from:

```text
https://<ida-deployment-origin>/hex.user.js
```

## Runtime behavior

1. Open and sign in to ChatGPT normally.
2. Select the ChatGPT model/reasoning mode you want to use.
3. The userscript prepares the Hex worker graph and opens Hex over the ChatGPT UI.
4. `ChatGPT Web` is the default AI provider. `Gemini 3.7 Flash` remains selectable from the Hex title bar.
5. Use the `ChatGPT` title-bar button to reveal the underlying ChatGPT UI for account/model changes. Use the floating `HEX` button to return.

If ChatGPT Web is selected and its bridge cannot complete a turn, Hex fails closed. It does not silently label a Gemini answer as ChatGPT output.

## CSP and Worker isolation

Hex network traffic to its deployment origin is performed through the userscript manager's `GM.xmlHttpRequest` transport. Classic Hex Worker dependencies are fetched, expanded into local Worker source, and launched through Blob URLs. The module platform worker is prebundled and launched through a Blob URL. Capstone WASM is fetched through the same userscript transport and exposed to its Worker through a local Blob URL.

This avoids making Hex's analysis data plane depend on ChatGPT's normal page `connect-src` or external worker/script permissions.

## Updating

The userscript declares `/hex.meta.js` as `@updateURL` and `/hex.user.js` as `@downloadURL`. `@version` is derived only from files that can alter the installed userscript, so generated-artifact, documentation, test, and workflow-only commits do not create false updates.

The `ChatGPT userscript host` GitHub Actions gate rebuilds the userscript and fails if the committed deployment bundles differ from source.
