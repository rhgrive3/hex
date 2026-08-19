# Universal Binary Foundation — historical foundation note

> **Status: HISTORICAL FOUNDATION SNAPSHOT.**  
> **Original note:** [`archive/platform/universal-binary-foundation.md`](archive/platform/universal-binary-foundation.md)  
> **Current platform document:** [`universal-platform.md`](universal-platform.md)  
> **Current capability truth:** [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md)

The archived note describes the point where `js/binary/` was deliberately isolated as an experimental format-neutral loader so it could mature without destabilizing the iOS/Mach-O path. That description is no longer current product state.

Today the format-neutral loader/platform is integrated into the product boundary for ELF/PE and shared capability routing. x86-64 and the frozen RISC-V64 Phase 6 profile also have real Semantic IR/CFG/SSA/MemorySSA/decompiler verticals through implemented depth A6; they must not be described as future architecture-IR work or decode-only support. Cumulative maturity remains A1 because complete A2 exact MachineEffects coverage is still partial, so this update does not inflate support claims.

PE support has also advanced beyond the old “delay-load imports are a future extension” wording: current parser/support evidence includes delay-import handling, while the full F3 import/export/relocation contract remains conservatively Partial.

Use the archived document for the original design rationale and parser API history; use `universal-platform.md`, current source/tests and `SUPPORT_MATRIX.md` for present behavior.
