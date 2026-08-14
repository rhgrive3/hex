# Hex AI agent core

## Purpose and trust boundary

Hex AI is an interface to Hex's analysis engines, not a second source of reverse-engineering facts. The language model plans, selects tools, interprets bounded observations, and explains results. Browser-side Hex code owns the binary, executes tools, validates addresses and scopes, produces evidence, and decides whether a claim is verified.

The binary file is never uploaded to the Worker. Only the user request, bounded excerpts, compact tool observations, evidence references, and compact conversation state cross the inference boundary. API credentials remain in the Worker environment.

```text
natural-language goal
        |
        v
browser AI turn router ---- chat (0-2 lightweight tools)
        |                 `-- agent (bounded plan/tool/verify loop)
        v
context broker (local context != model context)
        |
        v
deterministic tool registry --> Semantic IR / dataflow / xrefs / runtime / project
        |                              |
        v                              v
evidence + hypothesis stores <--- deterministic verifier
        |
        v
structured result + validated UI actions
        |
        v
Worker /api/ai/turn <----> provider inference only
```

The design follows the common execution contract in the current primary documentation for [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling), [OpenAI Agents SDK tools and guardrails](https://openai.github.io/openai-agents-js/guides/guardrails/), [OpenAI context management](https://openai.github.io/openai-agents-js/guides/context/), [Anthropic client tool loops](https://platform.claude.com/docs/en/agents-and-tools/tool-use/how-tool-use-works), and the [MCP host security boundary](https://modelcontextprotocol.io/specification/2025-06-18/architecture): the model emits typed requests, while the host validates and executes them. Hex implements only the small provider-neutral subset it needs and does not depend on an agent framework.

## Chat and agent runtimes

`chat` prioritizes latency. It can answer a general reverse-engineering question with no file or current function and permits at most two lightweight tool/model turns by default. Its context starts with a selection or active function only when relevant.

`agent` runs a bounded investigation. The existing `planAnalysisGoal` remains the deterministic first-stage planner: cheap lexical/string indexes create a shortlist, call-graph expansion adds candidates, Semantic IR analyzes only that shortlist, and deterministic verifiers rank the strongest candidates. The model can then choose additional allowlisted tools or submit a final structured result.

Beginner and analyst styles use the same analysis. Only the final presentation differs.

## Scope

The public scopes are `auto`, `selection`, `function`, `neighborhood`, `binary`, `project`, and `runtime`. Tool definitions state their supported scopes. The registry rejects an incompatible explicit scope before execution and can also delegate address-boundary checks to `scopeContainsAddress` in the local context.

`auto` may expand from selection to function, neighborhood, binary, project, or runtime. Every expansion becomes a `scope-expand` activity event. Activity contains deterministic lifecycle facts, never hidden chain-of-thought.

## Context broker and budgets

`ContextBroker` keeps the browser-only local context separate from the model projection. Local context may contain the binary object, indexes, runtime session, registry, stores, and project. The model projection contains only:

1. The current request and mode/style/scope.
2. Relevant verified and pinned evidence.
3. Active hypotheses.
4. Recent bounded observations.
5. A bounded selection/function excerpt.
6. A compact history summary and a few recent messages.

Old raw tool output is retained locally in `EvidenceStore`, not replayed on every model turn. The default context limit is 64 KiB for chat and 128 KiB for agent. Large functions are truncated before older high-priority evidence is removed.

All tool-derived text is tagged `untrusted-data`. The Worker system instruction explicitly treats strings, symbols, comments, assembly, and decompiler output as data even when they contain prompt-like or tool-call-like text.

## Tools and deterministic planning

`createHexToolRegistry` adapts existing Hex APIs instead of duplicating analysis algorithms. Every tool has a name, description, JSON input schema, cost, scope support, mutability classification, approval requirement, and executor. Arguments, addresses, scope, cancellation, output size, and optional output schemas are checked at the registry boundary.

The registry provides function/string search; current/selected/function context; xrefs/callers/callees; Semantic IR facts and decompilation; CFG; field/global reads and writes; value slicing; thresholds and field-update verification; related functions; knowledge/signature lookup; function comparison; project search; and conditional runtime/diff tools. Search output is bounded and expensive analysis is never started across every function in a large binary.

Candidate ranking exposes `lexicalScore`, `semanticScore`, `graphScore`, `evidenceScore`, `runtimeScore`, `totalScore`, and reasons. No opaque model score determines ordering.

## Evidence and hypotheses

Evidence records are created from deterministic tool results. Generic searches and semantic observations are `supported`; designated verifier results may be `verified`. Model output cannot insert a verified evidence record.

A hypothesis references known support and contradiction evidence IDs. `HypothesisStore` downgrades a model-requested `verified` status unless every supporting record is deterministically verified. Unknown evidence IDs are removed. Rejected hypotheses remain part of the investigation session.

The final consistency check removes missing evidence IDs and invented UI actions. Address actions are accepted only when the address exists in stored evidence and the local address validator does not reject it.

## Mutations and approval

Mutations are not model-callable tools. `ProposalStore` creates a pending proposal for rename, comment, type, struct field, patch, or project annotation. A proposal requires evidence. The UI (or another human-facing owner) approves it and receives an opaque approval token. Apply requires the token and verifies that the target's current state still matches the proposal's `before` fingerprint. Rejected or stale proposals fail without mutation, and every transition creates an audit event.

## Sessions and persistence

An investigation session stores the binary ID, mode/style/scope, goal, compact messages and summary, pinned evidence, hypotheses, confirmed findings, rejected hypotheses, proposals, and timestamps. Secret-looking keys are stripped before persistence. `.hexproj` findings now accept `investigationSessions` while remaining backward compatible with version 1 projects; binaries remain external and are never embedded.

## Provider and Worker boundary

`AIProvider.nextTurn(request, options)` is the only runtime dependency on inference. `WorkerAIProvider` implements it over same-origin `POST /api/ai/turn`; future providers can implement the same interface without leaking model names into UI code.

The Worker validates request size, mode/style/scope, bounded context, tool names, and tool schemas. Tool names must be in Hex's static allowlist. It rejects binary-shaped payloads, applies a per-isolate request rate limit, holds the Gemini key, disables provider storage, applies a timeout, and forces a complete function call. Browser tools are never executed by the Worker. `submit_hex_result` is the structured final-result function.

Agent function calls are executed only after the complete JSON response validates. `AbortSignal` propagates through provider fetch and tool execution; cancelling preserves the session and evidence already collected. Chat's legacy `/api/gemini`, `buildGeminiPayload`, and `streamGemini` paths remain available while UI migration proceeds.

## Errors and observability

Errors use stable categories: model timeout, provider error, invalid model output/tool call, tool failure, scope violation, budget exhaustion, cancellation, context too large, and approval required. A failed turn returns retained deterministic findings when possible rather than deleting session state.

Results include model/tool call counts, latency, maximum context bytes, candidate/analyzed function counts, disassembly count, and tool cost. Activity events expose tool and candidate lifecycle without model reasoning. Raw confidential tool output is not dumped to the console.

## Extension guide

To add a read tool:

1. Add its stable name to `AI_TOOL_NAMES`.
2. Register a definition in `createHexToolRegistry` with a narrow JSON schema, bounded output, cost, and exact scope support.
3. Reuse an existing Hex public API. Add a backward-compatible analysis API only if none exists.
4. Decide whether the result is merely supported evidence or comes from a deterministic verifier. Do not mark a discovery/search tool as a verifier.
5. Add validation, scope, truncation, cancellation, injection, and evidence tests.

Do not register mutating tools. Add a proposal kind and human-reviewed apply adapter instead. Provider adapters must return the shared `{type:"tool"}` or `{type:"final"}` protocol and must not execute analysis themselves.
