# Universal Binary Foundation

`js/binary/` is an experimental, format-neutral loader layer for hex. It is deliberately isolated from the current Mach-O analysis pipeline so it can be developed and measured without destabilising the iOS path.

## Why this exists

Higher-level analysis should not need to know whether an address came from Mach-O `LC_FUNCTION_STARTS`, ELF `.eh_frame_hdr`, or PE `.pdata`. It should receive the same model:

```text
bytes
  -> format loader (Mach-O / ELF / PE)
    -> BinaryImage
       segments / sections
       VA <-> file offset
       imports + binding sites
       exports / symbols / relocations
       high-confidence function seeds
       libraries / platform metadata
    -> future architecture IR / SSA / decompiler
```

This is a loader foundation, not a replacement decompiler. It intentionally stops before architecture-specific instruction semantics.

## Public API

```js
import {
  openBinary,
  scanStrings,
  auditBinary,
  capabilitiesOf,
  fingerprintImage,
  fingerprintFunction,
} from './js/binary/index.js';

const image = openBinary(bytes);

image.format;               // macho | elf | pe
image.arch;                 // arm64 | x86_64 | ...
image.entrypoint;           // BigInt | null
image.sections;
image.imports;              // format-neutral import records
image.functions;            // format-neutral function seeds
image.addressToOffset(va);
image.offsetToAddress(off);
image.readVirtual(va, len);
```

Addresses and file offsets use `BigInt` end-to-end. No parser relies on JavaScript's unsafe integer range.

## Function boundary sources

Every function seed carries its provenance and confidence. The loader never pretends all boundary mechanisms are equivalent.

| Format | Source | Meaning |
|---|---|---|
| Mach-O | `LC_FUNCTION_STARTS` | linker-emitted ULEB function starts |
| ELF | `.symtab` / `.dynsym` `STT_FUNC` | symbol-backed function |
| ELF | `.eh_frame_hdr` | unwind table function start; works on stripped executables |
| PE x64 | Exception Directory / `.pdata` | `RUNTIME_FUNCTION` begin/end |
| PE ARM64 | Exception Directory / `.pdata` | high-confidence begin; packed length when available |
| all | entrypoint | executable entry, weaker than boundary tables |

`mergeFunctionSeeds()` merges sources at identical addresses and retains provenance.

## Import resolution

### Mach-O

- undefined `LC_SYMTAB` entries
- classic dyld bind / weak-bind / lazy-bind opcodes
- `LC_DYLD_CHAINED_FIXUPS` import tables
- chained-fixup pointer walking for real binding sites
- library ordinal -> loaded dylib mapping

This matters for modern stripped iOS apps: the TsumTsum fixture has zero ordinary symbols but still recovers thousands of imports through chained fixups.

### ELF

- undefined dynamic/global symbols
- `REL` / `RELA` relocation sites linked back to imported symbols
- `DT_NEEDED` libraries

GNU symbol-version-to-library attribution is intentionally not guessed yet.

### PE

- Import Directory
- name and ordinal imports
- IAT binding address
- loaded DLL list

Delay-load imports are a future extension.

## Address model

`BinaryImage` owns address conversion. Higher layers must not repeat format-specific arithmetic.

- Mach-O: segment VM address / file offset
- ELF: `PT_LOAD` mapping, with alloc-section fallback
- PE: `ImageBase + RVA` mapped through sections

`auditBinary()` validates file ranges, VA/file-offset round trips, function placement and import-site mappings. This catches parser regressions before they become incorrect xrefs higher in the pipeline.

## Current format coverage

| Capability | Mach-O | ELF | PE |
|---|---:|---:|---:|
| 32/64-bit headers | yes | yes | PE32/PE32+ |
| endian handling | LE/BE | LE/BE | LE |
| universal/fat container | yes | n/a | n/a |
| segments + sections | yes | yes | yes |
| VA/file mapping | yes | yes | yes |
| libraries | dylibs | `DT_NEEDED` | DLLs |
| symbols | `LC_SYMTAB` | symtab/dynsym | COFF |
| imports | yes | yes | yes |
| concrete import sites | classic + chained binds | relocations | IAT |
| exports | export trie + symbols | dynamic/global symbols | Export Directory |
| relocations | loader bind sites | REL/RELA | base relocation blocks |
| stripped function seeds | `LC_FUNCTION_STARTS` | `.eh_frame_hdr` | `.pdata` |

## Deliberate non-goals for this branch

- replacing the existing `js/macho.js` path immediately
- architecture-specific disassembly/IR
- full DWARF/PDB parsing
- PE resources and Authenticode
- Mach-O code-signature verification
- ELF GNU symbol-version attribution
- full chained-rebase semantic decoding
- dynamic execution

Those should be separate layers built on top of `BinaryImage`.

## Integration strategy

Do not big-bang replace the current iOS parser.

1. Keep current Mach-O production pipeline unchanged.
2. Run `openBinary()` beside it in tests and compare sections/imports/functions.
3. Move generic consumers (file info, address conversion, libraries) first.
4. Add architecture adapters (`arm64`, `x86_64`, etc.) above `BinaryImage`.
5. Build the future IR/SSA layer against the format-neutral interface.
6. Only retire duplicate Mach-O plumbing after cross-binary oracle gates stay green.

This preserves the existing BattleCats/YWP/TsumTsum accuracy work while making ELF/PE first-class rather than bolt-ons.

## Tests

```bash
node tests/universal-binary.mjs
node tests/universal-binary-gate.mjs
node tests/universal-binary-benchmark.mjs
node tools/binary-inspect.mjs tests/battlecats
```

`universal-binary.mjs` contains deterministic synthetic ELF64 and PE32+ fixtures. The gate additionally uses the repository's three real iOS executables when present.
