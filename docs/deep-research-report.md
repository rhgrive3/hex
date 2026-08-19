# Hex Universal Binary Analysis Platform — Deep Research / Gap Analysis / Ideal Architecture

> **Status: HISTORICAL RESEARCH SNAPSHOT — not current implementation truth.**  
> **Research snapshot:** 2026-08-16, tied to the repository snapshot documented in `SOURCES.md`.  
> **Original report:** [`archive/research/deep-research-report-2026-08-16.md`](archive/research/deep-research-report-2026-08-16.md)  
> **Current architecture:** [`HEX_MASTER_ARCHITECTURE.md`](HEX_MASTER_ARCHITECTURE.md)  
> **Current support truth:** [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md)

This report was produced as a research/gap-analysis artifact against an earlier Hex snapshot. It contains valuable competitive analysis, design rationale and source exploration, but its statements of the form “Hex currently has/lacks X”, “x86-64 is unsupported for Y”, “RISC-V is missing”, or “the current core owns Z” are **historical observations** and MUST NOT be used as present implementation truth.

Since the snapshot, Hex has materially advanced. In particular, x86-64 and the frozen RISC-V64 Phase 6 profile now reach implemented analysis depth A6 in the machine-readable capability model, while cumulative maturity remains A1 because full A2 exact MachineEffects coverage is still partial. Semantic IR v2 compatibility is the production default behind the compatibility facade, so older descriptions of the mixed ARM64/AAPCS64 core as the sole production semantic path are also obsolete.

The archived original also contains ChatGPT session-local citation identifiers such as `turn…search…` and `turn…file…`. Those identifiers were useful during the research session but are not durable repository references. Use `SOURCES.md` for canonical external URLs and pinned source references.

## Use policy

- Use the archived report for historical rationale, competitor/tool comparison, research leads and design alternatives.
- Revalidate every statement about **current Hex behavior** against current source/tests.
- Use `js/platform/capability-maturity.js` plus `SUPPORT_MATRIX.md` for architecture/format maturity.
- Use `HEX_MASTER_ARCHITECTURE.md` for current normative architecture.
- Do not copy a historical “missing/weak/unsupported” classification into a new issue without first proving it still applies.

The original report is preserved byte-for-byte in the archive path above; no historical evidence was discarded.
