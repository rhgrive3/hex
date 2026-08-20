# Dev Agent Hardening — Weak-Model Execution Cards

**Status:** execution derivative of `docs/dev-agent-hardening-preflight.md`; subordinate to `docs/ENGINEERING_PROCESS_GUARDRAILS.md` and `docs/improving-agent.md`  
**Repository:** `rhgrive3/hex`  
**Target:** make the hardening executable by a weaker coding model with minimal architectural judgment while preserving or improving the final v2.3 outcome  
**Original baseline used to prepare these cards:** `bd03d1a860863814dbdcc00559709794d460189d`  
**Harness-alignment review revalidated against current main:** `0ba89b8f08bd821dcf55cb73fc21b926a43581f0`

---

## 0. How to use these cards

Run **one card at a time, in the listed order**. Do not give a weak model multiple implementation cards at once.

Default sequence:

```text
CARD 0  baseline/drift check        (no code change)
CARD A  characterization + test gate
CARD B  Pool waitResult() + lifecycle fencing
CARD C  Graph polling removal
CARD E  timeout semantics + quiescent cleanup
CARD F  bounded critical-path trace
CARD H0 prompt/tool compatibility + parity
CARD G  prompt BOOTSTRAP/CONTINUATION transport
CARD H1 canonical tool metadata registry
CARD H2 bounded deterministic observation batch
CARD I1 ContextPacket/WorkerResult representation
CARD I2 deterministic context selection
```

`CARD D` is **not** part of the default sequence. Run it only if, after CARD C, there is measured evidence that the Supervisor still polls graph/pool status in a way a host-side wait API would remove.

`CARD F1` is **not** part of the default sequence. It is an evidence-only target-device benchmark. Run it only after CARD F is active in the real iOS/iPadOS runtime and a measured effective-concurrency decision is actually needed. F1 does not change code or production defaults.

Every implementation card targets a **small ready-to-merge PR**. Unless the human explicitly overrides this rule, do not merge `main`, enable auto-merge, or combine cards in one PR.

### Why H2 is narrow

CARD H2 adopts only the useful round-trip reduction pattern from larger agent harnesses. It is deliberately **not** Code Mode and not a generic workflow engine. It adds one bounded read-only batch over tools already authorized and classified by H1, executes them sequentially through the existing direct-call path, and keeps all mutation/control/wait/full-turn operations out. This preserves Hex's one scheduler, one tool-contract truth, and browser/iPad-first constraints while reducing unnecessary Supervisor model turns.

---

## 1. Global rules for every card

These rules are repeated conceptually in every card and are non-optional.

1. Before editing, read:
   - root `AGENTS.md`;
   - `docs/ENGINEERING_PROCESS_GUARDRAILS.md`;
   - `docs/improving-agent.md` only for the relevant contract;
   - `docs/dev-agent-hardening-preflight.md` only for the relevant slice.
2. Fetch current `main` and the exact target files before editing.
3. If the relevant source materially differs from the assumptions in the card, **stop** and report `BASELINE_DRIFT`; do not redesign around it.
4. Do not create a second Worker Pool, scheduler, event bus, Context service, Memory Agent, vector DB, background iframe layer, or LLM summarizer.
5. Do not modify Standard Agent behavior.
6. Do not weaken runtime-activation, exact-head, target-device, lease cleanup, generated-output, or evidence requirements.
7. Do not invent tool names, file paths, IDs, CI results, runtime results, or tests.
8. Do not touch files outside `ALLOWED FILES` unless the card explicitly says to stop and report that another file is required.
9. Do not implement the next card early.
10. Do not refactor unrelated code “for cleanliness.”
11. Use focused tests first. Run broader applicable gates only at the card exit boundary.
12. If running inside GitHub Codespaces, follow the Graft rules in root `AGENTS.md`. Outside Codespaces, do not install/emulate/require Graft.
13. A Worker report is not proof. The final PR report must list actual changed files and actual observed test commands/results.
14. If a required assertion cannot be proved, report the exact blocker instead of approximating success.
15. Cancellation/deadline is not proof of quiescence. Started owned work must settle/be confirmed stopped before safe reuse, or fail closed through the existing discard path.
16. Tool batching never grants authority. Only tools explicitly marked by the canonical H1 registry as read-only observation-batch eligible may participate, and batching must use the same direct execution path.
17. Context compaction must preserve provenance and coverage lineage; never invent `coveredEvidenceRefs` merely to reduce bytes.

### Required final report format for every implementation card

Use exactly these headings:

```text
CARD: <id>
STATUS: PASS | BLOCKED | BASELINE_DRIFT
BRANCH: <branch>
PR: <number/url or NONE>
BASE_MAIN: <sha>
HEAD: <sha>
CHANGED_FILES:
- ...
TESTS:
- <command> => PASS|FAIL
INVARIANTS:
- <short evidence>
BLOCKERS:
- NONE | ...
NEXT_CARD: <id or NONE>
```

Do not claim `PASS` when a required test, diff check, or exact-head check was not observed.

---

## Card files

Read only this README, the one current card, and the referenced preflight slice. Do not load all card files into one implementation prompt.

```text
CARD_0.md
CARD_A.md
CARD_B.md
CARD_C.md
CARD_D_OPTIONAL.md
CARD_E.md
CARD_F.md
CARD_F1_OPTIONAL.md
CARD_H0.md
CARD_G.md
CARD_H1.md
CARD_H2.md
CARD_I1.md
CARD_I2.md
```

## 2. Phase 4 handoff gate after all default cards

Do not tell a weak model “start Phase 4” merely because I2 merged.

Before Phase 4, run a separate evidence-only readiness check:

```text
- current main exact SHA
- current docs/improving-agent.md contract still authoritative
- Pool completion long-turn polling removed
- stale wait/result cannot cross pool close/reinitialize ownership
- explicit/no-default timeout semantics verified
- cancellation/deadline cleanup preserves quiescent ownership or fails closed through discard
- bounded trace present and distinguishes queue/submit/completion/parse/release costs
- prompt/tool parity green
- BOOTSTRAP/CONTINUATION continuity tests green
- bootstrap-contract signature safely forces BOOTSTRAP on protocol/safety/tool-contract change
- canonical tool registry parity green, including owner and batchPolicy metadata
- bounded observation batch rejects every non-opted-in/non-observation target before execution
- direct vs batched eligible observations preserve equivalent result semantics
- ContextPacket/WorkerResult representation green, including terminalReason and coveredEvidenceRefs
- deterministic context-selection regression green and covered evidence is not double-injected
- active runtime identity updated before any live proof
- Standard Agent unchanged
```

Then begin Phase 4 at **read-only Project observation**, not mutation.

---

## 3. Weak-model anti-patterns — treat these as immediate STOP signals

If the implementation model proposes any of the following, stop that card and return to the exact instructions:

- “I will redesign the Worker architecture first.”
- “A central event bus would be cleaner.”
- “Let's introduce Redis/IndexedDB/vector DB for completion or memory.”
- “I'll rewrite DynamicTaskGraph while I am here.”
- “I'll combine timeout and completion changes.”
- “Abort fired, so the old Worker is reusable now.”
- “I'll make six Workers the default because six is supported.”
- “I'll summarize context with another LLM call every turn.”
- “I'll add a generic plugin framework for tool metadata.”
- “I'll add arbitrary JS/eval/Code Mode so batching is easier.”
- “Any observation-looking tool can go in the batch even if the registry did not opt it in.”
- “The PR is linked/CI was green earlier, so it is proven.”
- “This test is expensive, so I skipped it but the code looks correct.”
- “The Worker said it passed, so I marked it done.”
- “main moved, but my old-head checks are enough.”

---

## 4. Controller rule for the human/Supervisor

For a weak implementation model, **never ask it to both implement and decide whether the next architectural slice is appropriate**.

Use this control loop:

```text
human/strong reviewer chooses one card
-> weak model implements only that card
-> exact diff + tests reviewed
-> merge/reconcile decision happens outside the weak model
-> next card is issued only after the prior contract is green on current main
```

The weak model's job is local execution. Architectural authority remains in:

```text
docs/ENGINEERING_PROCESS_GUARDRAILS.md
> docs/improving-agent.md
> docs/dev-agent-hardening-preflight.md
> this execution-card derivative
```

If those conflict, this card file loses.
