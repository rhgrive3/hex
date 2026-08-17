# Phase 5 x86-64 compiler corpus

`manifest.json` freezes the Phase 5 mandatory semantic categories before broad
instruction-family implementation. Committed seed binaries are deterministic
P5-0 vertical-spine fixtures; later corpus entries must satisfy the frozen
categories and optimization matrix without deleting or weakening an entry.

Regenerate the seed from the repository root with the exact Clang identity and
flags recorded in the manifest. CI consumes the committed binaries and never
downloads compiler artifacts.
