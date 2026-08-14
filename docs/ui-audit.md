# Hex UI audit

## Scope and method

This audit was performed against the `origin/main` UI before the product-shell changes. The inventory was derived from the real UI-producing entrypoints in `index.html`, `js/app.js`, `js/ux.js`, `js/ui.js`, `js/panels.js`, and `js/tools.js`, including exported `show*` screen entrypoints, `new Sheet(...)` navigation, toolbar/menu actions, and the code-viewer navigation model.

The two primary screen-producing modules contained **54 exported `show*` entrypoints**: 35 in `js/panels.js` and 19 in `js/tools.js`. Private helper overlays such as graph help/name detail, menus, dialogs, toasts, and context pickers are intentionally not counted as screens.

## Before: architectural findings

1. **Two navigation models existed.** `ui.js` used `Sheet.parent`, `forward`, `parkedSheet`, and `MAX_DEPTH=8` as a browser-like history, while `navigation.js` separately tracked code-viewer locations.
2. **The DOM was an action registry.** `index.html` kept hidden source buttons alive and `app.js`/`ux.js` created newer controls that delegated to `button.click()`.
3. **`ux.js` was a patch layer.** It watched hidden buttons with `MutationObserver`, added `.ux-v2`, hid `.ux-source-action`, and projected a second navigation UI over the first.
4. **The information architecture was tool-first.** Overview, Investigate, Features, Search, Jump, Functions, Strings, Tools, Decompiler and reports competed as entry points even when they answered the same user goal.
5. **Function understanding was fragmented.** Summary, report, pseudocode, CFG, call graph, value flow, types, evidence, rename/comment and debugger were separate sheets.
6. **Deep information used transient UI.** Sheet stacking became the de-facto router; mobile users accumulated near-full-screen overlays instead of moving through real screens.
7. **CSS had generations of overrides.** `app.css` established the original system and `ux.css` overrode it later. Breakpoints and one-off presentation rules were distributed across files.
8. **Mobile inherited desktop structure.** Horizontal toolbar navigation, dense code columns and sheet-first detail presentation remained on phone widths.

## Old screen inventory: 54 exported entrypoints

### `js/panels.js` — 35

| Legacy entrypoint | User goal | Old primitive | Canonical destination |
|---|---|---|---|
| `showFileInfo` | inspect binary metadata | Sheet | Advanced |
| `showSections` | browse sections/slices | Sheet | Explorer / Sections |
| `showStructure` | inspect file/data structure | Sheet | Explorer / Data + Advanced |
| `showFunctions` | browse functions | Sheet | Explorer / Functions |
| `showFunctionSummary` | understand selected function | Sheet | Function Workspace / Overview |
| `showBlockDetail` | understand one basic block | Sheet | Function Workspace / Flow + Code inspector |
| `showFeatures` | find by feature words | Sheet | Investigate strategy |
| `showStrings` | browse strings | Sheet | Explorer / Strings |
| `showJump` | jump to address | Sheet | Global command/search |
| `showSearch` | search asm/text/hex/number/address | Sheet | Global command + Explorer |
| `showXrefs` | find references | Sheet | Function Workspace / Calls + Code inspector |
| `showDetail` | inspect instruction | Bottom Sheet | Code inspector; phone push/full-screen |
| `showOverview` | automatic overview + choose goal | Sheet | Investigate |
| `showAppMap` | understand subsystems | Sheet | Results + Explorer / Classes |
| `showSubsystem` | browse subsystem classes/functions | Sheet | Explorer / Classes |
| `showClass` | inspect class | Sheet | Explorer / Classes |
| `showField` | find reads/writes of a field | Sheet | Explorer / Data + Function evidence |
| `showPinned` | revisit a pinned answer | Sheet | Results / Finding |
| `showAccuracyNotes` | understand reliability | Sheet | Function Evidence + Results |
| `showInvestigate` | search by natural-language purpose | Sheet | Investigate |
| `showDataTables` | browse recovered data schemas | Sheet | Explorer / Data |
| `showDataTable` | inspect one recovered table | Sheet | Explorer / Data |
| `showCandidates` | choose likely answer | Sheet | Investigate + Results |
| `showCandidateWhy` | explain candidate ranking | Sheet | Finding + Function Evidence |
| `showFunctionReport` | understand a function | Sheet | Function Workspace / Overview |
| `showCallGraph` | inspect callers/callees | Sheet | Function Workspace / Calls |
| `showValueFlow` | follow a value | Sheet | Function workspace/context inspector |
| `showAddressInfo` | explain address mapping | Sheet | Global command + Code inspector |
| `showSettings` | change preferences | Sheet | Settings route |
| `showHelp` | get help | Sheet | Help route |
| `showWelcome` | first-use onboarding | Sheet | Investigate onboarding |
| `showLearn` | learn analysis concepts | Sheet | Learn route |
| `showGlossary` | find a term | Sheet | Learn |
| `showTerm` | read a term | Sheet | Learn |
| `showSampleGuide` | understand sample | Sheet | Investigate onboarding + Learn |

### `js/tools.js` — 19

| Legacy entrypoint | User goal | Old primitive | Canonical destination |
|---|---|---|---|
| `showTools` | choose an analysis tool | Sheet | Advanced + contextual actions |
| `showDecompiler` | read C-like reconstruction | Full Sheet | Function Workspace / Pseudocode |
| `showCfg` | inspect control flow | Full Sheet | Function Workspace / Flow |
| `showCallGraphPanel` | inspect call graph | Full Sheet | Function Workspace / Calls |
| `showTypes` | inspect inferred types | Sheet | Function Workspace / Overview |
| `showStructRecover` | recover a structure | Sheet | Function Overview + Explorer / Data |
| `showStructs` | browse saved structures | Sheet | Explorer / Data + Advanced |
| `showCxxClasses` | inspect C++ RTTI/vtables | Sheet | Explorer / Classes |
| `showRename` | rename a function | Sheet | Function context action |
| `showComment` | add a note | Sheet | Function/Code context action |
| `showNotes` | browse names/notes | Sheet | Results + Advanced |
| `showLinkage` | inspect imports/exports/libraries | Sheet | Explorer / External APIs |
| `showGlobals` | browse globals | Sheet | Explorer / Data |
| `showPatches` | manage patches | Sheet | Advanced + Code context action |
| `showPatchEditor` | edit one instruction | Sheet | Code context action |
| `showDebugger` | execute/verify function | Sheet | Function Workspace / Runtime |
| `showScript` | automate analysis | Sheet | Advanced |
| `showPlugins` | extend Hex | Sheet | Advanced |
| `showIl2cpp` | restore Unity metadata | Sheet | Explorer / Classes + Advanced |

`js/ui/registry.js` is the machine-testable migration table and must stay in sync with this document.

## Duplicate flows merged

The most significant duplicate user journeys were:

- Overview + Investigate + Feature Words → **Investigate**.
- Search + Jump + address search → **Global command/search**.
- Functions + Strings + Classes + Types + Sections + linkage/global indexes → **Explorer** scopes.
- Function Summary + Function Report → **Function Workspace / Overview**.
- Two call-graph entrypoints → **Function Workspace / Calls**.
- Decompiler + CFG + type/struct/debugger entrypoints → **Function Workspace tabs/context**.
- Accuracy/reliability displays → semantic **Evidence** status (`Confirmed`, `Likely`, `Unverified`, `Contradicted`) rather than ranking score.
- Tool catalog → normal operations are contextual; only low-level operations remain under **Advanced**.

## After: canonical route map

There are **10 canonical routes/workspaces**:

- `/investigate`
- `/code/:address?`
- `/explorer/:scope?`
- `/results`
- `/function/:address/:tab?`
- `/finding/:id`
- `/settings`
- `/help`
- `/learn`
- `/advanced`

The persistent primary navigation contains only four user goals: **Investigate, Code, Explorer, Results**. Settings, Help, Learn and Advanced are secondary.

## Component map

Canonical screens are built from shared primitives in `js/ui/primitives.js`: screen header, cards, semantic states, evidence badges, tabs, rows, empty/loading/error states, and a windowed `VirtualList`. Code and graph visualizations retain specialized renderers.

`js/ui/router.js` owns browser-backed route history and serializable view state. `js/ui/product.js` owns navigation wiring and domain adapters. `js/ux.js` is now only a compatibility bootstrap; it no longer observes, hides, or clicks source buttons.

## Mobile problems addressed

- persistent 4-item bottom navigation under 900px;
- phone-specific code-column reduction;
- local horizontal scrolling for pseudocode/code rather than body scrolling;
- full route-based Function Workspace;
- windowed Explorer suitable for very large indexes;
- safe-area variables and `dvh`/`visualViewport` keyboard bridge;
- compressed landscape phone chrome with side navigation;
- graph viewport plus text representation;
- 44px shared touch target;
- reduced-motion and focus-visible handling.

## Compatibility boundary

Legacy `Sheet` remains available for transient actions and low-level screens not yet worth duplicating (patch editor, rename/comment pickers, old instructional material). It is no longer the canonical navigation model. The migration manifest prevents those compatibility entrypoints from becoming new top-level destinations.
