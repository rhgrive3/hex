# Universal Binary Foundation — Validation Notes

This document records what was actually exercised before the branch was handed off. It is intentionally separate from the architectural overview: support claims should be backed by a reproducible fixture or an explicitly stated limitation.

## Deterministic tests

`tests/universal-binary.mjs` builds format fixtures in memory and validates:

- byte reader bounds and ULEB128
- format detection
- canonical FNV-1a 64-bit digest compatibility
- thin arm64 Mach-O parsing
- FAT/universal Mach-O slice selection
- Mach-O `LC_MAIN`, dylib loading and `LC_FUNCTION_STARTS`
- ELF64 sections, dynsym, imported/defined symbols and `DT_NEEDED`
- PE32+ ImageBase/RVA mapping
- PE Import Directory/IAT site recovery
- PE x64 Exception Directory `.pdata` function begin/end
- format-neutral address mapping and audits

`tests/universal-binary-sectionless.mjs` independently constructs an ELF64 image with **zero section headers**. All dynamic-loader metadata is exposed only through `PT_DYNAMIC`. The test requires the loader to recover:

```text
DT_NEEDED -> libc.so.6
DT_STRTAB / DT_SYMTAB -> puts
DT_HASH -> dynamic symbol count
DT_RELA -> concrete puts binding site
```

This protects the non-iOS path from silently becoming section-name dependent.

## Real iOS fixture gate

The repository's BattleCats, TsumTsum and YWP executables were parsed through the new loader without using the production Mach-O parser.

Observed results:

| Fixture | Size | Imports | Binding sites | Import coverage | Functions | Symbols | Audit errors |
|---|---:|---:|---:|---:|---:|---:|---:|
| BattleCats | 28,153,072 | 3,079 | 44,736 | 98.60% | 102,852 | 3,119 | 0 |
| TsumTsum | 45,994,784 | 3,189 | 54,783 | 100.00% | 152,488 | 0 | 0 |
| YWP | 63,455,952 | 2,908 | 92,161 | 98.42% | 293,794 | 2,946 | 0 |

The TsumTsum result is particularly important: its ordinary symbol table contributes no symbols, yet `LC_DYLD_CHAINED_FIXUPS` still recovers 3,189 imports and their binding sites. A loader that only reads `LC_SYMTAB` would classify this binary incorrectly.

`tests/universal-binary-baseline.json` stores these observations. The executable fingerprints remain identical after replacing the byte-at-a-time BigInt FNV implementation with the two-limb implementation, providing an exactness check for that optimization.

## Performance observed during development

Loader-only parsing on the available execution environment was approximately:

- BattleCats: 0.7–0.8 s
- TsumTsum: 0.8–0.9 s
- YWP: 1.4–1.8 s

These are observations, **not CI performance requirements**. Hardware, Node version and garbage collection make strict timing gates brittle. The regression gate checks semantic counts and integrity instead.

Fingerprinting originally used a BigInt multiplication for every byte. That was exact but disproportionately expensive on tens of MiB of executable code. `fingerprint.js` now keeps the FNV-1a state in two 32-bit limbs and converts to BigInt only at the public API boundary. Canonical vectors are tested so performance work cannot silently change fingerprints.

## Additional ELF smoke test

The loader was also run on the development environment's stripped `/bin/ls`:

```text
ELF x86_64 64-bit
30 sections
122 imports
325 relocations
3 needed libraries
333 function seeds
0 audit errors
0 audit warnings
```

`.eh_frame_hdr` reported and recovered all 333 table entries. This is an environment smoke test, not a repository golden fixture, because `/bin/ls` varies across distributions.

## Integrity rules

`auditBinary()` checks invariants that higher analysis layers depend on:

- mapped file ranges do not exceed the input
- VA -> file offset -> VA round trips
- function starts resolve into executable mapped memory
- import sites resolve to file-backed locations where applicable
- entrypoint resolves into executable mapped memory
- duplicate function starts are removed before higher analysis consumes them

A parser returning more names is not considered an improvement if it violates these invariants.

## What is still intentionally incomplete

### Mach-O

- uncommon/legacy threaded bind opcodes are not fully interpreted
- full chained **rebase** semantics are not exposed yet; bind sites are the current priority
- code-signature/SuperBlob validation is not part of this layer
- Objective-C/Swift metadata belongs above `BinaryImage`

### ELF

- full `.eh_frame` parsing when `.eh_frame_hdr` is absent
- GNU symbol-version attribution (`DT_VERSYM`, `DT_VERNEED`) to map an import to one exact `DT_NEEDED` library
- compressed/debug DWARF
- extended program-header count (`PN_XNUM`) edge cases
- architecture-specific relocation semantics beyond retaining relocation type/index/addend

### PE

- Delay Import Directory
- PDB/CodeView symbol loading
- resources/version info
- Authenticode verification
- complete ARM64 unwind expansion for non-packed records

## Handoff rule

This branch deliberately does **not** replace the production `js/macho.js` pipeline. The safe integration path is adapter-first:

```text
existing production parser -----> current ARM64 analysis
             |                         |
             | compare/oracle          |
             v                         |
       BinaryImage <-------------------+
             |
             +---- future architecture-neutral IR / SSA
```

Only move existing consumers to `BinaryImage` after their current BattleCats/YWP/TsumTsum oracle metrics remain equal or improve. A broad parser rewrite and a new SSA implementation should not land in one unreviewable change.
