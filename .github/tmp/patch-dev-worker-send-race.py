from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if text.count(old) != 1:
        raise SystemExit(f"expected exactly one patch target in {path}, got {text.count(old)}")
    p.write_text(text.replace(old, new, 1))

replace_once(
    "js/userscript/chatgpt-adapter.js",
    """    const composer = await waitFor(() => this.adapter.composer(), Math.min(timeoutMs, this.startTimeoutMs), signal);\n    if (!composer) throw bridgeError('turn-controller', 'composer-not-found', 'ChatGPT composer was not found.');\n    if (this.adapter.isGenerating()) throw bridgeError('turn-controller', 'already-generating', 'ChatGPT is already generating a response.');\n\n    const baselineAssistant = new Set(this.assistantTurns().map((turn) => turn.id));\n    const baselineUsers = new Set(this.userTurns().map((turn) => turn.id));\n    const baselineConversation = new Set(this.conversationTurns().map((turn) => turn.id));\n    const baselinePageErrors = pageErrorSignatures(this.adapter);\n    this.adapter.setComposerText(composer, prompt);\n    const send = await waitFor(() => {\n      const node = this.adapter.sendButton();\n      return node && !node.disabled && node.getAttribute?.('aria-disabled') !== 'true' ? node : null;\n    }, Math.min(this.startTimeoutMs, remaining(started, timeoutMs)), signal);\n""",
    """    let composer = await waitFor(() => this.adapter.composer(), Math.min(timeoutMs, this.startTimeoutMs), signal);\n    if (!composer) throw bridgeError('turn-controller', 'composer-not-found', 'ChatGPT composer was not found.');\n    if (this.adapter.isGenerating()) throw bridgeError('turn-controller', 'already-generating', 'ChatGPT is already generating a response.');\n\n    const baselineAssistant = new Set(this.assistantTurns().map((turn) => turn.id));\n    const baselineUsers = new Set(this.userTurns().map((turn) => turn.id));\n    const baselineConversation = new Set(this.conversationTurns().map((turn) => turn.id));\n    const baselinePageErrors = pageErrorSignatures(this.adapter);\n    const send = await waitFor(() => {\n      // ChatGPT can replace the New Chat composer during SPA hydration on\n      // iOS/WebKit. Never keep waiting on text injected into a detached editor:\n      // re-target the currently authoritative composer and require an exact\n      // prompt match there before invoking Send.\n      const currentComposer = this.adapter.composer();\n      if (!currentComposer) return null;\n      const currentText = normalizeText(this.adapter.composerText(currentComposer));\n      if (currentComposer !== composer || currentText !== normalizedPrompt) {\n        this.adapter.setComposerText(currentComposer, prompt);\n        composer = currentComposer;\n      }\n      if (normalizeText(this.adapter.composerText(currentComposer)) !== normalizedPrompt) return null;\n      const node = this.adapter.sendButton();\n      return node && !node.disabled && node.getAttribute?.('aria-disabled') !== 'true' ? node : null;\n    }, Math.min(this.startTimeoutMs, remaining(started, timeoutMs)), signal);\n""",
)

replace_once(
    "tests/fixtures/chatgpt-production-dom.mjs",
    "  const composer = document.getElementById('prompt-textarea');",
    "  let composer = document.getElementById('prompt-textarea');",
)
replace_once(
    "tests/fixtures/chatgpt-production-dom.mjs",
    """  function showSend() {\n    actions.innerHTML = '<button type=\"button\" data-testid=\"send-button\" aria-label=\"プロンプトを送信\">送信</button>';\n  }\n""",
    """  function showSend(disabled = false) {\n    actions.innerHTML = '<button type=\"button\" data-testid=\"send-button\" aria-label=\"プロンプトを送信\"'\n      + (disabled ? ' disabled aria-disabled=\"true\"' : '') + '>送信</button>';\n  }\n""",
)
replace_once(
    "tests/fixtures/chatgpt-production-dom.mjs",
    """    configure(next) {\n      options = next;\n      if (options.seedPageErrorText) flashPageError(options.seedPageErrorText, 0);\n    },\n""",
    """    configure(next) {\n      options = next;\n      if (options.seedPageErrorText) flashPageError(options.seedPageErrorText, 0);\n      if (options.composerHydrationDelayMs) {\n        // iPad Safari capture: New Chat can expose a provisional editor before\n        // React/ProseMirror replaces it. Input on that stale editor never enables\n        // the send control for the hydrated editor.\n        showSend(true);\n        const staleComposer = composer;\n        setTimeout(() => {\n          if (!staleComposer.isConnected) return;\n          const hydratedComposer = staleComposer.cloneNode(false);\n          hydratedComposer.textContent = '';\n          staleComposer.replaceWith(hydratedComposer);\n          composer = hydratedComposer;\n          hydratedComposer.addEventListener('input', () => showSend(false));\n        }, options.composerHydrationDelayMs);\n      }\n    },\n""",
)

replace_once(
    "tests/chatgpt-web-production-dom.mjs",
    """    await scenario(context, name, 'a short prompt is captured', { prompt: SHORT_PROMPT }, (result) => {\n      assert.equal(result.ok, true, `${name}: ${result.error?.code}`);\n      assert.equal(result.value.text, ANSWER);\n    });\n\n""",
    """    await scenario(context, name, 'a short prompt is captured', { prompt: SHORT_PROMPT }, (result) => {\n      assert.equal(result.ok, true, `${name}: ${result.error?.code}`);\n      assert.equal(result.value.text, ANSWER);\n    });\n\n    await scenario(context, name, 'New Chat composer rehydration is retried before send', {\n      prompt: SHORT_PROMPT, chatgpt: { composerHydrationDelayMs: 120 },\n    }, (result) => {\n      assert.equal(result.ok, true, `${name}: a provisional iOS composer must not strand Worker submission (${result.error?.code})`);\n      assert.equal(result.value.text, ANSWER);\n    });\n\n""",
)
