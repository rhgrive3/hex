# hex — iOS ARM64 Hex / Assembly Viewer

A browser-based viewer for Mach-O executables and raw ARM64 code, built for
reading large amounts of disassembly on an iPad (designed against iPad mini 6,
portrait and landscape) in Safari.

It is a **viewer**, not an editor: the file you open is never modified, never
uploaded, and never leaves the device. Everything — Mach-O parsing, Capstone
disassembly, search — runs locally in a Web Worker.

```
ADDRESS      HEX            INSTRUCTION
100001000    FF 83 00 D1    sub    sp, sp, #0x20
100001004    FD 7B 01 A9    stp    x29, x30, [sp, #0x10]
100001008    F6 57 BD A9    stp    x22, x21, [sp, #-0x30]!
```

## Using it

1. Open the page and tap **Open**, then pick a binary from the Files app.
2. Mach-O images are recognised automatically; `__TEXT,__text` is selected and
   disassembled straight away.
3. **Assembly / Hex** switches the display. **Sections** navigates segments and
   sections (and architecture slices in a universal binary). **Go to** jumps to
   an address (`10000C448` or `0x10000C448`). **Search** looks for instruction
   text, hex byte patterns (`FD 7B ?? A9`), or an address.
4. Tap an instruction for its address, bytes, mnemonic and operands; long-press
   for Copy Address / Hex / Assembly / All.
5. **Select** starts a range. Tap (or long-press) another row to select through
   it — scrolling in between is fine, and the far end can be anywhere in the
   section. The bar at the bottom shows how many rows are selected and copies
   them as rows, addresses, hex or assembly. **All** selects the whole section,
   **Done** clears the selection.

With a hardware keyboard: `⌘F` search, `⌘G` or `G` go to address, arrows /
page keys / Home / End to move, `Esc` to close. Hold `⇧` with any movement key
to extend the selection, `⌘A` to select the section, `⌘C` to copy it.

Copied ranges are one row per line: addresses as `0x100001000`, hex as the
row's four bytes, assembly as `mnemonic operands`, and "Copy Rows" as all
three separated by tabs. Up to 200,000 rows go on the clipboard at once.

## Deploying to GitHub Pages

Push the repository and enable Pages on the branch root. Nothing is built and
nothing is fetched from a CDN, so `https://<user>.github.io/<repo>/` works as
is — every path in the app is relative.

The page must be served over http(s); opening `index.html` from the file system
does not work, because browsers refuse to start workers and WebAssembly from
`file://`.

## What's in here

```
index.html          app shell
css/app.css         all styling (light + dark, portrait + landscape)
js/app.js           wiring: chrome, state, file lifecycle, keyboard
js/state.js         application state + persisted preferences
js/backend.js       worker client, chunk cache (LRU), prefetch
js/viewer.js        virtualized code viewer
js/panels.js        sheets: file info, sections, go to, search, detail, settings
js/rangecopy.js     copying a selected range of rows to the clipboard
js/ui.js            sheets / menus / dialogs / toasts / clipboard
js/format.js        address, hex and size formatting; input parsing
js/lru.js           bounded cache
js/worker.js        file I/O, Mach-O parsing, Capstone, search  (classic worker)
js/macho.js         Mach-O reader (header, load commands, segments, sections)
capstone.js         Capstone 5 compiled to WebAssembly (@alexaltea/capstone-js)
capstone.wasm       …and its WebAssembly module — both files are required
```

## How it stays fast on large files

* **Nothing is disassembled up front.** Rows are produced in 4 KiB chunks on
  demand, disassembled in the worker and kept in a 64-entry LRU cache.
* **Only visible rows exist in the DOM** (~45 elements), recycled while
  scrolling. No row is ever created or destroyed during a scroll.
* **The scroll container is capped at 6,000,000 px.** It shows a *window* of
  rows; when the user scrolls near an edge and the scroll comes to rest, the
  window is re-based and `scrollTop` shifts by the same amount, so the view
  never moves and inertial scrolling is never interrupted. A 32 MB `__text`
  (8.4 M instructions) scrolls end to end at 60 fps.
* **Addresses are BigInt everywhere.** ARM64 is fixed width, so row ↔ address is
  exact: `address = section.vmaddr + row × 4`.
* **Undecodable words are shown, not skipped.** Capstone runs with `SKIPDATA`,
  so data inside code appears as `.byte` rows and every 4-byte word keeps its
  address.

## Limits

* Disassembly is ARM64 (AArch64) only. Other Mach-O architectures still show
  their header, sections and bytes; the Assembly tab is disabled for them.
* Symbols, cross-references, function lists and Objective-C/Swift metadata are
  not implemented.
* App Store binaries with `cryptid = 1` are detected and flagged: their `__TEXT`
  is encrypted on disk, so it will not disassemble into meaningful code.
