# Dev Agent Hardening — Weak-Model Execution Cards

**Status:** execution derivative of `docs/dev-agent-hardening-preflight.md`; subordinate to `docs/ENGINEERING_PROCESS_GUARDRAILS.md` and `docs/improving-agent.md`  
**Repository:** `rhgrive3/hex`  
**Target:** make the hardening executable by a weaker coding model with minimal architectural judgment while preserving or improving the final v2.3 outcome  
**Baseline used to prepare these cards:** live `main` observed at `bd03d1a860863814dbdcc00559709794d460189d`  

---

## 0. How to use these cards

Run **one card at a time, in the listed order**. Do not give a weak model multiple implementation cards at once.

Default sequence:

```text
CARD 0  baseline/drift check        (no code change)
CARD A  characterization + test gate
CARD B  Pool waitResult()
CARD C  Graph polling removal
CARD E  timeout semantics
CARD F  bounded critical-path trace
CARD H0 prompt/tool compatibility + parity
CARD G  prompt BOOTSTRAP/CONTINUATION transport
CARD H1 canonical tool metadata registry
CARD I1 ContextPacket/WorkerResult representation
CARD I2 deterministic context selection
```

`CARD D` is **not** part of the default sequence. Run it only if, after CARD C, there is measured evidence that the Supervisor still polls graph/pool status in a way a host-side wait API would remove.

Every implementation card targets a **small ready-to-merge PR**. Unless the human explicitly overrides this rule, do not merge `main`, enable auto-merge, or combine cards in one PR.

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
CARD_H0.md
CARD_G.md
CARD_H1.md
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
- explicit/no-default timeout semantics verified
- bounded trace present
- prompt/tool parity green
- BOOTSTRAP/CONTINUATION continuity tests green
- canonical tool registry parity green
- ContextPacket/WorkerResult representation green
- deterministic context-selection regression green
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
- “I'll make six Workers the default because six is supported.”
- “I'll summarize context with another LLM call every turn.”
- “I'll add a generic plugin framework for tool metadata.”
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
