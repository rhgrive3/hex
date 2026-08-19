# Phase 8 — Opus 5 Execution Amendment

> **Status:** Current-main execution amendment for Phase 8 planning.
> **Scope:** This file does not weaken `HEX_MASTER_ARCHITECTURE.md`, `ENGINEERING_PROCESS_GUARDRAILS.md`, `MIGRATION_GUARDRAILS.md`, or `PHASE8_CHECKPOINT_CONTRACTS*.md`.
> **Precedence:** Where `PHASE8_FAST_PATH.ja.md` can be read as allowing a looser dependency order, this amendment wins.

## 1. Operator rule

For a strong implementation agent such as Opus 5:

1. Read this amendment first.
2. Use `PHASE8_FAST_PATH.ja.md` as the normal operator entrypoint.
3. Treat Master Architecture and Guardrails as absolute constraints.
4. Treat the current checkpoint contract as the acceptance contract.
5. Reuse existing implementation before adding new frameworks.
6. Make the smallest change that closes the current checkpoint DoD.
7. If a dependency is not yet accepted, do not integrate dependent production behavior; prepare fixtures, negative tests, research, review, or a non-invasive skeleton instead.
8. Stop once the checkpoint minimum success condition is met. Do not expand into speculative superoptimization, framework rewrites, or Phase 9 work.

## 2. Correct production-acceptance dependency DAG

```text
P8-0  Foundation / current truth / ownership / verifier
  ↓
P8-1  Transactional pass substrate
  ↓
P8-2  SCCP + wrapped range/value-set
  ↓
P8-3  GVN/CSE + effect-aware DCE
  ↓
P8-4  Induction + loop facts
  ├───────────────┐
  ↓               ↓
P8-5 Structuring  P8-6 Aggregate/array/union recovery
  └───────┬───────┘
          ↓
P8-7 Language/compiler providers
          ↓
P8-I Final integration/cutover
```

The key distinction is **parallel prework vs production acceptance**:

- P8-3 and P8-4 are not fully parallel for acceptance. P8-4 may prepare tests/query contracts while P8-3 is being completed, but P8-3 acceptance closes first.
- P8-5 and P8-6 both depend on accepted P8-4 induction/loop facts.
- After P8-4 is accepted, P8-5 and P8-6 implementation/tests may proceed in parallel, but candidate acceptance and checkpoint integration remain serialized according to the normative checkpoint transaction.
- P8-7 comes after generic optimizer/recovery/structuring contracts are stable.

## 3. Safe parallel prework

While P8-1/P8-2 are on the critical path, prepare in parallel:

- P8-3: scalar CSE, memory-version, alias-barrier, unknown-call, volatile/atomic/mayThrow negative corpus;
- P8-4: canonical/decrement/non-unit/wrapping/pointer/multiple-backedge/early-exit induction corpus;
- P8-5: irreducible SCC, exception-edge, multi-exit, necessary-goto fixtures;
- P8-6: struct-vs-array, union, padding, flexible-array, contradictory-type fixtures;
- P8-7: existing idiom/provider inventory;
- representative pathological-function performance fixture.

Do not parallelize ownership of shared pipeline write points, integration reconciliation, or committed generated output.

## 4. Validation cadence

Use three levels:

### Tier A — inner loop

Run focused owned tests, minimal positive/negative counterexamples, determinism, provenance, relevant budget/cancellation checks, and affected static checks. Do not run every full-product verifier after every edit.

### Tier B — candidate merge tree

Before component acceptance, prove the actual candidate tree: refetch exact heads, inspect changed-file ownership, run governance, rolling product gates, independent shadow verification, and applicable semantic/decompiler/cross-architecture evidence.

### Tier C — accepted checkpoint

After merge on the exact integration head: reconcile shared contracts, update invalidation/version identities where applicable, regenerate owned generated output, require rebuild zero-diff, run rolling vertical + independent verifier, and record exact checkpoint evidence. Do not unlock the next component merge until this is green.

## 5. Failure rule

Always repair the first deterministic divergence:

```text
exact failing head
→ first deterministic divergence
→ owner analysis/pass
→ minimal counterexample
→ owner-layer fix
→ permanent regression
→ affected evidence rerun
→ Tier B/C proof at the boundary
```

Do not hide semantic, CFG, alias, type, or effect failures in the pretty-printer.

## 6. Stop conditions

At each checkpoint, stop expanding the implementation when all are true:

```text
required behavior implemented
+ required positive/negative corpus green
+ semantic/provenance/unknown-safety invariants green
+ checkpoint performance budget satisfied
+ no unresolved merge blocker
```

Do not continue merely because the framework could be more general, goto count could be lower, the range domain could be richer, or future Phase 9 could use additional machinery.

## 7. Final principle

> Parallelize preparation and independent leaf work. Serialize semantic acceptance where dependencies require it. Keep exact-product safety gates intact, and remove only duplicate thinking, duplicate testing, duplicate rebases, duplicate generated sync, and downstream symptom debugging.
