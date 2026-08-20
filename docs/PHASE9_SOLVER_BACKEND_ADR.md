# ADR-0009: Solver Backend Provider Selection for Phase 9

- **Status**: Proposed / Evaluation Baseline (P9-1)
- **Deciders**: Hex Architecture Team / Phase 9 Owner
- **Date**: 2026-08-20
- **Scope**: Master Architecture Phase 9 — Solver-backed Verification

---

## 1. Context and Problem Statement

Phase 9 introduces solver-backed formal verification into Hex for conditional edge feasibility, bounded equivalence, and patch verification over Semantic IR.
Hex is designed under strict environment and product constraints:
1. **Browser & iPad-first**: Primary target is Safari / WebKit on iPadOS and modern desktop browsers.
2. **Offline-first & Privacy**: Hex analyzes proprietary or sensitive binary binaries locally; project-derived constraints, symbol names, and addresses **must not egress** to remote third-party servers by default.
3. **Resource & Memory Safety**: iOS WebKit tabs operate under strict memory caps (typically 1.5GB to 2GB before tab discard). Solver execution must be bounded, measured, cancellable, and recyclable.
4. **Deterministic & Replayable**: Verification evidence must be reproducible with deterministic seeds, options, and fixed-width bitvector semantics.

We need to evaluate candidate solver providers for Hex's `SolverBackend` interface.

---

## 2. Candidate Evaluation

### Candidate 1: Z3 WASM (`z3-solver` / Emscripten WebAssembly)
- **License**: MIT
- **Capabilities**: Full SMT-LIB 2.6, industry standard for QF_BV (Quantifier-Free Bitvectors), arrays, uninterpreted functions, arithmetic, and quantifiers.
- **WASM Support**: Mature Emscripten build (`z3-solver` npm package / custom minimal build).
- **Pros**:
  - Extremely reliable and mature QF_BV theory solving and model generation.
  - Robust C/C++ codebase compiled to WASM.
  - Broad community support and reproducible seed options.
- **Cons / Risks**:
  - Full WASM bundle is relatively large (~15-25MB uncompressed, ~5MB gzip/brotli).
  - Emscripten heap allocation requires careful lifecycle management to prevent memory leaks across sessions.
  - Must run inside a dedicated WebWorker to avoid blocking the main UI thread during intensive checks.

### Candidate 2: cvc5 WASM
- **License**: BSD 3-Clause
- **Capabilities**: Strong SMT solving, proof production, extensive bitvector & string theories.
- **WASM Support**: Available via Emscripten.
- **Pros**:
  - High performance, modern proof generation architecture.
- **Cons / Risks**:
  - Larger WASM footprint and complex compilation pipeline compared to Z3.
  - Memory consumption in WebKit is comparatively higher during initialization.

### Candidate 3: Bitwuzla WASM
- **License**: MIT
- **Capabilities**: World-class SMT solver specifically tailored for Quantifier-Free Bitvectors (QF_BV), Floating-Point, and Arrays.
- **WASM Support**: Can be built via Emscripten.
- **Pros**:
  - Extremely fast QF_BV solving on symbolic execution benchmarks.
  - Lean codebase and smaller potential WASM binary.
- **Cons / Risks**:
  - Less widespread JS/WASM packaging in standard npm ecosystem; requires maintaining a custom WASM build pipeline.

### Candidate 4: Remote SMT Solver Gateway (HTTP / WebSocket RPC)
- **License**: N/A (Server-side)
- **Capabilities**: Unbounded compute on native server clusters.
- **Pros**:
  - Zero browser WASM bundle overhead.
  - Can leverage massive multi-core native SMT instances.
- **Cons / Risks**:
  - **Violates core Hex privacy and offline-first invariants**: Binary structures, control flow offsets, and semantic constraints would leak over the network.
  - Network latency and transport timeouts.
  - Hard dependency on remote availability.

---

## 3. Decision Matrix

| Criteria | Z3 WASM | cvc5 WASM | Bitwuzla WASM | Remote RPC |
| :--- | :--- | :--- | :--- | :--- |
| **Offline & Privacy** | **Pass (100% Local)** | **Pass (100% Local)** | **Pass (100% Local)** | **FAIL (Data Egress)** |
| **iPad/WebKit Compatibility** | **Pass (Worker WASM)**| Pass (Worker WASM) | Pass (Worker WASM) | Pass (Network fetch) |
| **BV Semantics & Accuracy** | **Exemplary** | Exemplary | Exemplary | Exemplary |
| **Bundle & Init Overhead** | ~5 MB compressed | ~8 MB compressed | ~3 MB compressed | 0 MB (Remote) |
| **Cancellation & Teardown** | Worker `terminate()` | Worker `terminate()` | Worker `terminate()` | HTTP abort |
| **Ecosystem Maturity** | **High** | Medium | Medium | High |

---

## 4. Decision Outcome

1. **Local-first WASM Architecture**: Hex adopts a local-first WebAssembly solver architecture executing in an isolated WebWorker.
2. **Primary Provider (Wave 1 Candidate)**: **Z3 WASM** is selected as the primary general-purpose solver backend for initial Wave 1 integration due to its proven stability, MIT license, and standard SMT-LIB compliance.
3. **Secondary / Specialized Candidate**: **Bitwuzla WASM** is designated as the preferred target for high-performance bitvector-only optimization in subsequent phases.
4. **Remote Solver Policy**: Remote solvers are **strictly forbidden** as default or silent fallback. Any future remote solver interface will require explicit user opt-in, policy disclosure, and strict redaction of binary provenance.

---

## 5. Implementation Roadmap for P9-2 / Wave 1

1. Create `Z3WasmBackend` and `Z3WorkerSession` implementing `SolverBackend` and `SolverSession`.
2. Worker lifecycle management:
   - Worker creation with structured messaging (`check`, `cancel`, `dispose`).
   - Hard cancellation via WebWorker `terminate()` if cooperative interrupt exceeds safety budget.
3. Lowering from Hex solver-neutral Expr DAG to SMT-LIB 2.6 / Z3 AST within the worker.
4. Model extraction and normalization into Hex `SolverResult.model`.
