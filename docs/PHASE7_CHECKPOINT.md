# Phase 7 checkpoint record

Status: **living integration evidence**
Runbook: [`PHASE7_STATIC_ANALYSIS_EXECUTION_PLAN.md`](PHASE7_STATIC_ANALYSIS_EXECUTION_PLAN.md)
Process contract: [`ENGINEERING_PROCESS_GUARDRAILS.md`](ENGINEERING_PROCESS_GUARDRAILS.md)

This document is the human projection of `reports/phase7/checkpoints.json`. The
machine-readable ledger is authoritative; this file exists so a reviewer can see
where the phase reached without running anything.

## Baseline

| Fact | Value |
|---|---|
| Live `main` at phase start | `bdf90569ed037a3d30e4439dcde970aad9352e21` |
| Integration branch | `phase7/static-analysis-depth` |
| Mandatory architecture lanes | `arm64`, `x86_64`, `riscv64` |
| Supplementary lane | `arm64e` (partial coverage; may add evidence, never substitutes) |
| Debug ecosystems | DWARF (ELF/Mach-O), PDB (PE) |

The architecture lanes are resolved from `js/platform/capability-maturity.js` at
phase start, not copied from the runbook — the runbook's matrix is a review-time
observation and goes stale (§5.1).

## What each checkpoint added

| Checkpoint | Contribution |
|---|---|
| P7-0 | Analysis status envelope, artifact identity, frozen corpus/query/truth/scoring manifest, negative soundness corpus, verifier mutant self-tests, permanent exact-head verifier in shadow mode, ownership gate |
| P7-1 | A1 region alias: proof-carrying relations over the existing conservative floor, plus proven-distinct-address-space separation |
| P7-2 | A2 field-sensitive points-to: range-valued fixed point over the SSA phi graph, checked interval arithmetic, explicit provenance loss |
| P7-3a | Local `FunctionSummary` whose contract makes "we did not look" structurally distinct from "there is nothing there" |
| P7-3b | Escape analysis with reason/boundary taxonomy and root-origin tracking; feeds A2 as a later refinement |
| P7-3c | A3 interprocedural SCC solving: least fixed point, finite effect lattice, conservative republication on non-convergence |
| P7-4 | Hard `TypeConstraintGraph`: four separate layers, authoritative-origin gate on hard constraints, contradictions withhold selection |
| P7-5a | `DebugInfoProvider` boundary and DWARF 4/5 ingestion, identity-bound by build id or debug-link CRC |
| P7-5b | PDB ingestion through the same boundary, identity-bound by CodeView GUID **and** age |
| P7-6 | Function discovery as generic evidence fusion, with start and extent as independent facts |
| P7-I | Public analysis surface, CI workflows, exact integrated proof |
| P7-X | Phase 8 handoff contract and exit evidence |

## Measured results

Same frozen query set, same denominator, baseline versus candidate:

| Metric | Baseline | Candidate |
|---|---|---|
| Exact alias relations proven | 1/3 | 3/3 |
| Strong proven rate | 0.077 | 0.231 |
| May rate | 0.923 | 0.769 |
| Unknown rate | 0.000 | 0.000 |
| False `NoAlias` | 0 | 0 |
| False `MustAlias` | 0 | 0 |
| Exact memory links | 2 | 2 |
| Barriers correctly held | 2 | 2 |
| Barrier bypasses | 0 | 0 |

Soundness counters across the other lanes, all required to be zero:

| Lane | Counter | Value |
|---|---|---|
| Summaries | missing effects / invented effects / false purity | 0 / 0 / 0 |
| Summaries | wrong completeness / non-convergent / nondeterministic | 0 / 0 / 0 |
| Escape | missed escapes / false non-escape | 0 / 0 |
| Types | false certainty (debug-assisted + no-debug) | 0 |
| Debug | authoritative facts from a mismatched source | 0 |
| Discovery | false starts / false split / false merge / overclaimed extents | 0 / 0 / 0 / 0 |

Type accuracy is reported separately with and without debug evidence (1.000 and
1.000 on the frozen corpus) so DWARF/PDB cannot conceal an inference regression.

Function discovery reports start and extent independently: start recall 1.000,
start precision 0.929, extent precision 1.000. The precision figure is not 1.0
because a shared epilogue reached by a single exception-metadata reference is
raised as a `heuristic` candidate — a proposal, which is what heuristics are
for, and explicitly not a claimed function start.

## Generated output

Phase 7 edits `js/analysis/**` and `js/semantics/compat/index.js`, both inside
the protected userscript runtime, so every accepted checkpoint changes the
canonical build output. Phase 7 is a single-owner phase and is therefore also
the release owner: it rebuilds with the canonical builder, commits, and rebuilds
again requiring a zero diff, before the next dependent checkpoint is accepted.

The first ownership manifest got this wrong — it declared that Phase 7 owned no
generated output — and CI caught the contradiction immediately. The manifest was
corrected rather than the gate weakened.

## Known limitations

These are recorded rather than hidden. None of them is a soundness gap; each is
a precision or coverage bound that the current contract states explicitly.

- A2 does not resolve pointers through loads or calls. Those remain unresolved
  boundaries, reported with an explicit loss reason.
- The DWARF reader covers the abbreviation table, the CU DIE tree and the string
  sections. Line programs, location lists and range lists are not consumed;
  their absence is reported as a diagnostic and keeps the result incomplete.
- The PDB reader covers the MSF container, the info/DBI/TPI streams and the
  symbol records. Unmodelled CodeView symbol kinds are listed as diagnostics and
  keep the result `partial`.
- Architecture-specific prologue producers are a contract Phase 7 defines but
  does not populate: registering them belongs to the target boundary, which
  Phase 7 does not own.
- The frozen corpus is synthetic microfixtures plus real compiler/linker debug
  output. It is deliberately small and exact; a large real-binary corpus is a
  separate, larger investment.

## Phase 8 handoff

Phase 8 consumes `js/analysis/index.js` and nothing else. The boundary supplies:

| Capability | What Phase 8 gets |
|---|---|
| `alias(a, b)` | relation, closed-vocabulary proof reasons, evidence ids, status |
| `reachingMemoryDef(load)` | the reaching definition, an explicit `blocked` flag, status |
| `explainMemoryPath(load)` | the evidence path between a source and a sink |
| `memoryEffects(scope)` | read/write regions, unresolved calls, conservative `mayWrite`, status |
| `functionSummary()` | the immutable summary and its dependency-bearing status |
| `escape()` | escape records with reason and boundary, plus proven non-escaping roots |
| `explainType(entityId)` | per-layer candidates, hard constraints, soft evidence, contradictions |
| `functionCandidates(...)` | starts and regions with independent start/extent evidence |
| `analyzeInterproceduralSummaries(...)` | solved summaries with completeness and dependency identity |

A test asserts that nothing under `js/decompiler`, `js/ui` or `js/ai` imports a
Phase 7 solver internal, so SCCP, GVN, DCE, load-store forwarding and aggregate
recovery can be built on these answers without coupling their correctness to how
A1/A2/A3 happen to be implemented today.

What Phase 8 must not assume:

- that a `may` or `unknown` alias answer will ever become `no` — both block a
  transform that requires separation, and neither is a promise about the future;
- that a summary without a listed write effect is pure — `summaryMayWriteRegion`
  is the only sanctioned question, and it answers conservatively whenever the
  summary cannot prove otherwise;
- that a `certain` type conclusion survives new evidence — a later hard
  constraint can introduce a contradiction, at which point selection is
  withheld;
- that a function candidate's extent is known because its start is exact.
