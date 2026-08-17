/*
 * Production ChatGPT DOM fixture.
 *
 * The markup below is a structural transcription of an iPad Safari ChatGPT Web
 * page captured during a real Hex incident. Only the shapes Hex depends on are
 * kept — conversation-turn sections, the accessibility-only speaker headings,
 * the role nodes, the collapsible long-prompt container with its localized
 * toggle labels, the composer, and the send/stop controls. Conversation titles,
 * sidebar history and account data from the capture are deliberately absent.
 *
 * Every attribute name and localized string here was present in the capture:
 *   <section data-testid="conversation-turn-N" data-turn="user|assistant"
 *            data-turn-id="<uuid|request-WEB:...>">
 *   <h4 class="sr-only">あなた:</h4> / <h4 class="sr-only">ChatGPT:</h4>
 *   [data-message-author-role="user"|"assistant"][data-message-id]
 *   [data-testid="collapsible-user-message-root"][data-collapsed]
 *     [data-testid="collapsible-user-message-content"]
 *     button[data-testid="collapsible-user-message-toggle"]
 *       「表示を増やす」「表示を減らす」
 *   button[data-testid="stop-button"][aria-label="回答を停止"]
 */

export const COLLAPSIBLE_PROMPT_THRESHOLD = 400;

export const PAGE_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>ChatGPT</title>
<style>
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  [data-testid="collapsible-user-message-root"][data-collapsed] [data-testid="collapsible-user-message-content"] {
    max-height: 8.5rem; overflow: hidden;
  }
  [data-testid="collapsible-user-message-root"]:not([data-can-expand]) button { display: none; }
  .whitespace-pre-wrap { white-space: pre-wrap; }
</style></head>
<body><div id="__next">
  <nav id="history">
    <button type="button" data-testid="create-new-chat-button" aria-label="新しいチャット">新しいチャット</button>
  </nav>
  <main>
  <div id="thread"></div>
  <form id="composer-form">
    <div id="prompt-textarea" contenteditable="true" role="textbox" aria-multiline="true"
         aria-label="ChatGPT とチャットする" data-virtualkeyboard="true"></div>
    <div id="composer-actions">
      <button type="button" data-testid="send-button" aria-label="プロンプトを送信">送信</button>
    </div>
  </form>
  </main></div></body></html>`;

/*
 * The ChatGPT lifecycle simulator. It runs inside the page and reproduces the
 * ordering the capture proves: the user turn and an assistant placeholder appear
 * together while the SPA is still on "/", the stop button exists for the whole
 * generation, and the conversation URL is adopted only after streaming starts.
 */
export const CHATGPT_STUB = `
window.__CHATGPT__ = (() => {
  const thread = document.getElementById('thread');
  const history_nav = document.getElementById('history');
  let composer = document.getElementById('prompt-textarea');
  const actions = document.getElementById('composer-actions');
  let turnIndex = 0;
  let options = {};
  let state = null;

  function esc(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function userBody(text) {
    if (text.length < ${COLLAPSIBLE_PROMPT_THRESHOLD}) {
      return '<div class="whitespace-pre-wrap">' + esc(text) + '</div>';
    }
    /* Long prompts render collapsed, with the toggle as a SIBLING of the
       content node. Reading the role node instead of the content node appends
       the localized toggle labels to the message text. */
    return '<div data-testid="collapsible-user-message-root" data-collapsed="" data-can-expand="">'
      + '<div id="collapse-target" data-testid="collapsible-user-message-content">'
      + '<div class="whitespace-pre-wrap">' + esc(text) + '</div>'
      + '</div>'
      + '<button type="button" aria-controls="collapse-target" aria-expanded="false"'
      + ' data-testid="collapsible-user-message-toggle">'
      + '<span>表示を増やす</span><span>表示を減らす</span></button>'
      + '</div>';
  }

  function appendUserTurn(text, turnId) {
    const section = document.createElement('section');
    section.setAttribute('data-testid', 'conversation-turn-' + (++turnIndex));
    section.setAttribute('data-turn', 'user');
    section.setAttribute('data-turn-id', turnId);
    section.innerHTML = '<h4 class="sr-only">あなた:</h4>'
      + '<div data-message-author-role="user" data-message-id="' + turnId + '">'
      + userBody(text) + '</div>';
    thread.append(section);
    return section;
  }

  function appendAssistantTurn(turnId) {
    const section = document.createElement('section');
    section.setAttribute('data-testid', 'conversation-turn-' + (++turnIndex));
    section.setAttribute('data-turn', 'assistant');
    section.setAttribute('data-turn-id', turnId);
    section.innerHTML = '<h4 class="sr-only">ChatGPT:</h4>'
      + '<div data-message-author-role="assistant" data-message-id="request-placeholder-' + turnId + '">'
      + '<div aria-busy="true">思考中</div></div>';
    thread.append(section);
    return section;
  }

  function flashPageError(text, durationMs = 40) {
    const node = document.createElement('div');
    node.setAttribute('role', 'alert');
    node.setAttribute('data-testid', 'toast-error');
    node.textContent = text;
    document.body.append(node);
    if (durationMs > 0) setTimeout(() => node.remove(), durationMs);
    return node;
  }

  function appendErrorTurn(text) {
    const section = document.createElement('section');
    section.setAttribute('data-testid', 'conversation-turn-' + (++turnIndex));
    section.setAttribute('data-turn', 'assistant');
    section.innerHTML = '<h4 class="sr-only">ChatGPT:</h4>'
      + '<div data-message-author-role="assistant" data-message-id="err-' + turnIndex + '">'
      + '<div data-testid="conversation-turn-error">' + esc(text) + '</div></div>';
    thread.append(section);
    return section;
  }

  function showStop() {
    actions.innerHTML = '<button type="button" data-testid="stop-button" aria-label="回答を停止">停止</button>';
  }
  function showSend(disabled = false) {
    actions.innerHTML = '<button type="button" data-testid="send-button" aria-label="プロンプトを送信"'
      + (disabled ? ' disabled aria-disabled="true"' : '') + '>送信</button>';
  }

  function assistantBody(section) {
    return section.querySelector('[data-message-author-role="assistant"]');
  }

  function openNewChat(domDelayMs = 0) {
    history.replaceState({}, '', '/');
    showSend();
    const clear = () => { thread.replaceChildren(); turnIndex = 0; };
    if (domDelayMs > 0) setTimeout(clear, domDelayMs);
    else clear();
  }

  function replaceWithConversation(conversationId) {
    history.replaceState({}, '', '/c/' + conversationId);
    thread.replaceChildren();
    turnIndex = 0;
    appendUserTurn('別の既存会話', 'other-user-' + conversationId);
    const assistant = appendAssistantTurn('other-assistant-' + conversationId);
    assistantBody(assistant).innerHTML = '<div class="markdown">別の既存会話の回答</div>';
    showSend();
  }

  function stream(section, chunks, done) {
    const body = assistantBody(section);
    let index = 0;
    body.innerHTML = '<div class="markdown"></div>';
    const tick = () => {
      if (index >= chunks.length) { done(); return; }
      /* ChatGPT re-hydrates the streaming node: the markdown element is
         replaced while the logical conversation turn stays the same. */
      const next = document.createElement('div');
      next.className = 'markdown';
      next.textContent = chunks.slice(0, ++index).join('');
      body.replaceChildren(next);
      setTimeout(tick, options.streamMs);
    };
    setTimeout(tick, options.streamMs);
  }

  function onSend() {
    const text = composer.innerText;
    composer.innerHTML = '';
    showStop();
    const turnId = 'turn-' + Math.random().toString(16).slice(2);
    /* A human message that lands in the same tab inside Hex's submit window:
       two fresh user turns appear between the baseline and the first probe. */
    if (options.manualInterference) appendUserTurn('人が手で入力した別の質問', 'manual-' + turnId);
    const initialUserText = options.userHydrationDelayMs ? text.slice(0, Math.max(1, Math.floor(text.length / 3))) : text;
    const user = appendUserTurn(initialUserText, turnId);
    if (options.userHydrationDelayMs) {
      setTimeout(() => {
        const role = user.querySelector('[data-message-author-role="user"]');
        if (role) role.innerHTML = userBody(text);
      }, options.userHydrationDelayMs);
    }
    if (options.pageErrorText) {
      setTimeout(() => flashPageError(options.pageErrorText, options.pageErrorDurationMs ?? 40), options.pageErrorAtMs ?? 10);
    }
    const assistant = appendAssistantTurn('request-WEB:' + turnId + '-0');
    state = { user, assistant };

    setTimeout(() => {
      if (options.adoptConversation !== false) {
        history.replaceState({}, '', '/c/' + options.conversationId);
      }
      if (options.transientRouteGapMs) {
        /* ChatGPT briefly reports no conversation at all during an SPA route
           transition. Unknown is not the same as "a different conversation". */
        setTimeout(() => {
          history.replaceState({}, '', '/');
          setTimeout(() => history.replaceState({}, '', '/c/' + options.conversationId), options.transientRouteGapMs);
        }, options.transientRouteAtMs ?? 30);
      }
      if (options.migrateToConversation) {
        // Real new-chat traces keep the exact user/assistant data-turn-id while
        // ChatGPT replaces a provisional conversation id with its final id.
        setTimeout(() => history.replaceState({}, '', '/c/' + options.migrateToConversation), options.migrateAtMs ?? 40);
      }
      if (options.navigateToConversation) {
        // A real switch loads another turn set; the active Hex request identity
        // disappears instead of migrating with the route.
        setTimeout(() => replaceWithConversation(options.navigateToConversation), options.navigateAtMs ?? 40);
      }
      if (options.navigateToNewChat) {
        // Production changes the route before tearing down the old turn DOM.
        setTimeout(() => openNewChat(options.navigationDomDelayMs ?? 300), options.navigateAtMs ?? 40);
      }
      if (options.failActiveTurn) {
        const body = assistantBody(assistant);
        body.innerHTML = '<div data-testid="conversation-turn-error">Something went wrong while generating the response.</div>';
        showSend();
        return;
      }
      stream(assistant, options.chunks, () => {
        showSend();
      });
    }, options.adoptAfterMs ?? 20);
  }

  document.getElementById('composer-form').addEventListener('click', (event) => {
    if (event.target.closest('[data-testid="send-button"]')) onSend();
  });

  history_nav.addEventListener('click', (event) => {
    if (!event.target.closest('[data-testid="create-new-chat-button"]')) return;
    openNewChat(options.newChatDomDelayMs || 0);
  });

  return {
    configure(next) {
      options = next;
      if (options.seedPageErrorText) flashPageError(options.seedPageErrorText, 0);
      if (options.composerHydrationDelayMs) {
        // iPad Safari capture: New Chat can expose a provisional editor before
        // React/ProseMirror replaces it. Input on that stale editor never enables
        // the send control for the hydrated editor.
        showSend(true);
        const staleComposer = composer;
        setTimeout(() => {
          if (!staleComposer.isConnected) return;
          const hydratedComposer = staleComposer.cloneNode(false);
          hydratedComposer.textContent = '';
          staleComposer.replaceWith(hydratedComposer);
          composer = hydratedComposer;
          hydratedComposer.addEventListener('input', () => showSend(false));
        }, options.composerHydrationDelayMs);
      }
    },
    /* Seeded turns belong to an already-open conversation: this is the shape
       that lets a failure from an earlier turn sit in the DOM while a new,
       healthy Hex request runs. */
    seedHistory(turns, conversationId) {
      history.replaceState({}, '', '/c/' + conversationId);
      const link = document.createElement('a');
      link.setAttribute('href', '/c/' + conversationId);
      link.textContent = '会話';
      history_nav.append(link);
      for (const turn of turns) {
        if (turn.kind === 'error') appendErrorTurn(turn.text);
        else if (turn.kind === 'user') appendUserTurn(turn.text, 'seed-' + turnIndex);
        else appendAssistantTurn('seed-' + turnIndex);
      }
      showSend();
    },
  };
})();
`;
