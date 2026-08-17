# Phase 4 independent verification reports

This directory is owned by the P4-6/P4-7 verification and integration lanes. Production source is never repaired from this directory.

## Run

From a repository checkout on the P4-6 branch or an integration candidate:

```sh
node tools/validation/phase4/verify.mjs --base <common-phase4-base-sha>
```

The runner executes the independent P4 oracle suite, the Phase 3 regression oracle, the required repository validation commands, and the official P4-6 ownership gate. It writes both JSON and Markdown reports named `verification-<head>.json` and `verification-<head>.md`.

`--no-commands` exists only for harness development. A report produced with that switch is necessarily blocking because required executable gates were not run.

## Decision rule

A missing production integration is never skip-green. It is emitted as:

```text
NOT-INTEGRATED / BLOCKING
```

The runner returns success only when all independent raw-failure counters are zero, all required commands pass, Phase 3 regression evidence is complete, and no static integration blocker remains.

## Required raw counters

Every machine report contains numeric raw counts for:

- `determinismFailures`
- `underInvalidationFailures`
- `overInvalidationFailures`
- `corruptionAcceptanceFailures`
- `partialPublishFailures`
- `warmUnexpectedProducerInvocations`
- `coalescingFailures`
- `cancellationFailures`
- `wholeFileMaterializationFailures`
- `coldWarmMismatchCount`
- `ownershipViolations`

Additional counters are allowed. Percentages are not used as a substitute for raw failures.

## First-divergence taxonomy

| Code | First divergence |
| --- | --- |
| A | ArtifactKey |
| B | producer normalization |
| C | dependency identity |
| D | scheduler |
| E | cancellation/budget |
| F | persistent write |
| G | persistent read |
| H | hot cache |
| I | project index |
| J | paging |
| K | migration |
| L | packaging/CI |
| M | unrelated main change |

A report records the responsible component lane and, when a frozen/shared path can only be changed by integration, the P4-7 repair lane separately.

## Scaling

The independent stress matrix is `10`, `100`, `1,000`, and `10,000`. Reports include elapsed time, per-item time, producer invocation counts, scheduler coalescing counts, and queue-operation counts. Deterministic operation counts are preferred to timing for complexity alarms; timing is retained as performance evidence.

## Phase 3 regression oracle

P4 must preserve the executable Phase 3 release evidence already carried by `tests/semantic-v2/run.mjs`:

- `tests/ir.mjs`: 30/30
- semantic command corpus: 11/11
- decompiler command corpus: 14/14
- legacy-v1/current differential: 25/25, mismatch 0
- provenance loss: 0
- unknown-store safety failures: 0
- unknown-call safety failures: 0

The P4 runner parses the current process output (`[phase3-current-corpus]`, `[phase3-final-evidence]`, and `[phase3-release-report]`) instead of copying a historical PASS result into a new report.

## CI integration

P4-6 is intentionally not allowed to edit `package.json` or `.github/workflows/**`. If the current release runner does not invoke `tools/validation/phase4/verify.mjs`, the static oracle reports category **L** as `NOT-INTEGRATED / BLOCKING`; P4-7 owns that final wiring.
