# AI Analyst UX

How the assistant is put together, and which decisions are load-bearing.

## The goal

A beginner should reach the right function, the evidence for it, and the next
action faster than an experienced IDA user working by hand — without first
learning which of Hex's screens to open. The assistant is how that happens, so
it cannot be a chat box bolted to the side: the conversation has to be an
analysis surface, and every answer has to end somewhere in the code.

The workbench stays the product. The assistant is ambient.

## Layout

| Width | Layout | Behaviour |
|---|---|---|
| ≥ 900px | docked column | the workspace shrinks; code stays visible and usable |
| 600–899px | bottom sheet | modal, dismissed by Escape or ✕, and collapses when an action navigates |
| < 600px | full screen | same, plus the primary navigation hides while it is open |

Closed, the assistant is one 48px launcher at the bottom right, clear of the
bottom navigation and the safe area. It shows a quiet ring while working and a
counted dot when an answer arrived while it was closed. It never flashes.

## Modules

```text
js/ai/prompts/     core, chat, agent, beginner, analyst, task, compose
js/ai/ui/          assistant, panel, launcher, session, modes,
                   bridge, local-engine, hex-context, workbench
js/ai/render/      normalize, message, answer, evidence, hypothesis,
                   proposal, activity, status, terms, missing
js/ai/interaction/ omnibox, contextual, actions
css/ai/            launcher, panel, message
```

`assistant.js` composes the parts and owns nothing else. `session.js` is a
pure state machine (turns, mode/style/scope, cancel, retry) with the engine
injected, so a full turn runs in a Node test with no browser.

## Boundary with the AI core

The AI core (`js/ai/runtime.js`, `js/ai/tools/*`, `js/ai/context/*`,
`js/ai/provider/*`, `js/ai/schema.js`) owns the canonical runtime/schema/tool
contract. The UI never imports the core statically:

1. `bridge.js` dynamically imports the core on the first question. If it is
   available, `AIRuntime.turn()` drives the turn and its proposal store backs
   the approval UI.
2. A deterministic/local fallback exists for configurations where the core or
   provider is genuinely unavailable and policy permits it. **Safety-boundary
   failures do not fall through.** Scope/session-binding failures are rethrown,
   and in ChatGPT-userscript mode an unexpected core/ChatGPT failure is surfaced
   unless an explicit Gemini fallback/provider selection permits the local
   path. This prevents a failed protected turn from being silently re-run
   against a different live function, binary, session, or provider.

`hex-context.js` is the adapter between the app (workers, BigInt regions,
caches) and the plain capability object the core expects. It is read-only.
Mutations go through the proposal path, never through a tool.

`render/normalize.js` is the only place that touches the raw result schema.
Unknown fields are collected in `unknownFields` and reported in the UI rather
than dropped, so a schema addition surfaces as a visible note and a failing
test instead of silently disappearing.

## Prompts

`composePrompt()` assembles core → mode → style → scope → task hint →
workbench state. Every part is a plain string, so what the assistant is told is
as testable as what it renders (`tests/ai-prompt-compose.mjs`).

The task hint is chosen by a conservative intent match
(`explain_instruction`, `trace_value`, `find_field_writer`, …); when nothing
matches clearly, no hint is added. A single giant prompt that tries to cover
every question makes every answer slightly wrong.

`compactGuidance()` returns only the per-turn parts, for transports that carry
their own fixed system instruction and a bounded question budget.

## Presentation rules

- **Evidence is separated from prose.** A claim is read once; its proof is
  navigated. Cards carry the address, the source tool, and a one-tap jump.
- **Four core evidence states** — verified / supported / hypothesis / unknown —
  each with a word and a glyph, never colour alone. The product UI may also
  render a separate contradicted presentation state when evidence conflicts.
- **One confidence scale.** A percentage is shown only for a probability
  produced by evidence fusion. A model or ranking score gets stars and a
  verdict word, because a ranking score is not a probability.
- **Agent progress is factual.** Steps and counts, collapsed by label. No plan
  narration, no chain-of-thought.
- **Beginner vs Analyst is not a skin.** Beginner leads with the conclusion,
  explains at most a few terms inline from the glossary, and keeps proof one
  disclosure away. Analyst front-loads identity, evidence and cost.
- **Machine codes never reach the user.** `render/missing.js` turns
  `no-runtime-or-causal-verification` into what is missing plus the question
  that would resolve it.

## Approval

Reading is free. Any change to project state is rendered as a before/after
proposal with its reason and evidence count, and nothing happens until Apply is
pressed. Apply re-reads the live value first: a proposal whose target moved
underneath it fails loudly instead of overwriting newer work.

## Tests

| Suite | Covers |
|---|---|
| `tests/ai-prompt-compose.mjs` | prompt composition, task detection, fallbacks |
| `tests/ai-ui-mode.mjs` | session state machine, scope resolution, omnibox intents |
| `tests/ai-ui-evidence.mjs` | schema normalization, forward compatibility, one-scale rule |
| `tests/ai-ui-launcher.mjs` | launcher, layouts, focus, Escape, code reachability |
| `tests/ai-ui-panel.mjs` | modes, styles, scope, evidence navigation, cancel/retry, volume |
| `tests/ai-ui-proposal.mjs` | the whole approval gate, including a stale target |
| `tests/ai-ui-fallback.mjs` | the offline/policy-permitted fallback path |
| `tests/ai-ui-core-integration.mjs` | a real turn through the AI core |

`npm run ai:test` runs the Node suites; `npm run ai:browser` runs the browser
suites (included in `npm run ui:browser`).
