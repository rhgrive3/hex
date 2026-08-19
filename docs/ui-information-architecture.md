# Hex product UI information architecture

## Product principle

Hex presents analysis in this order:

**Question → Answer → Evidence → Detail**

Users should not need to choose an internal analysis algorithm before they can ask a useful question. Internal strategies such as string search, feature grouping, dataflow, decompilation and runtime verification are selected by context and exposed only when they help explain an answer.

## Canonical terminology

| Canonical term | Meaning | Do not use as competing top-level labels |
|---|---|---|
| 調べる / Investigate | ask a question or start automatic investigation | 自動解析, 機能から探す, 目的から探す as separate destinations |
| コード / Code | current assembly/hex address context | Viewer, Raw view as top-level destinations |
| 索引 / Explorer | browse/search entities in the binary | Functions, Strings, Sections as separate top-level pages |
| 結果 / Results | findings, evidence, history and pins | Reliability/Pins as separate global destinations |
| 関数 / Function Workspace | understand one function progressively | Function Summary, Function Report, Decompiler as competing screens |
| 根拠 / Evidence | why a conclusion is supported | ranking score, stars or probability presented as certainty |
| 高度な機能 / Advanced | patch/script/plugin/raw low-level tools | Tools as a beginner destination |

Beginner-facing copy describes intent: 「値の流れ」「なぜそう言える？」「書き換えている場所」. Formal terms such as SSA, Memory SSA and architecture-specific details remain available in expert detail.

## Top-level navigation

The persistent navigation has four entries only:

1. **調べる / Investigate** — structured question entry.
2. **コード / Code** — current assembly/hex context, and the default route.
3. **索引 / Explorer** — entity browsing/search.
4. **結果 / Results** — revisit conclusions and evidence.

The four entries live in the chrome row as compact tabs from 900px up, and are pinned to the bottom of the viewport below that. There is no left rail: the width it reserved belongs to the disassembly.

**Code is the default route**, before a file exists as well as after. With no file open the workbench shows a compact open/sample card in the viewer area; opening a file goes straight to the instructions instead of a question screen or an overview sheet. Investigate remains one tap away for a structured goal, and the AI Assistant answers a question asked in ordinary language from wherever the user already is.

Secondary destinations live in More: Settings, Learn, Help and Advanced. Functions, Sections, Structure, Search and Tools are never repeated there. Diff is a canonical non-primary route reached contextually rather than a fifth persistent navigation item.

## Route hierarchy

```text
/investigate
/code/:address?
/explorer/:scope?
  functions
  strings
  classes
  data
  external
  sections
/results
/diff
/finding/:id
/function/:address/:tab?
  overview
  pseudocode
  flow
  calls
  evidence
  runtime
/settings
/help
/learn
/advanced
```

`ProductRouter` uses browser history rather than retaining screen DOM. A route may serialize scroll/query/filter/selection state into `history.state`; views are rebuilt from cached domain results when restored.

## Global command/search

The global field accepts intent without requiring command syntax:

- `0x100458C00` → address navigation;
- `sub_100458C00` → open that function;
- `"reward"` → string search;
- `PlayerData` / `Reward` → Explorer search across relevant names;
- `> settings` or `> 設定` → command navigation;
- `? コインが増えるのはどこ` → ask the AI Assistant.

The classified intent is named beside the field as the user types (`js/ai/interaction/omnibox.js`), so pressing Enter is never a surprise. Command syntax is optional. `Cmd/Ctrl+K` and `/` focus the field for expert use.

## AI Assistant

The assistant is ambient, never a destination: a 48px launcher at the bottom right, a docked column beside the code from 900px up, a bottom sheet on a tablet, full screen on a phone. The docked layout shrinks the workspace rather than covering it; the overlay layouts step aside as soon as an action navigates.

| Control | Meaning |
|---|---|
| チャット / Chat | fast answers about the current context; no binary-wide search |
| エージェント / Agent | search, trace and verify, reporting factual progress events |
| やさしく / Beginner | conclusion first, terms explained, evidence one disclosure away |
| 解析者 / Analyst | addresses, facts and cost front-loaded |
| 範囲 / Scope | Auto, selection, function, neighborhood, binary, project, runtime |

Every answer carries evidence, hypotheses and executable actions rather than prose alone, and every card ends somewhere in the code. Reading needs no approval; any change to project state (rename, comment, type, patch) is a proposal card that does nothing until the user presses Apply.

## Investigate

Investigate is a primary structured-question screen, **not the default landing route**. It contains:

- natural-language goal input;
- common goal suggestions;
- recent questions;
- automatic overview entry;
- contextual next questions/results.

Feature words, strings, function candidates and other strategies are implementation details of the investigation flow, not competing global destinations.

## Explorer

Explorer has one search model with scopes:

- Functions
- Strings
- Types / Classes
- Data
- External APIs
- Sections

Large flat lists use `VirtualList`; only visible rows plus overscan exist in the DOM. Source/query budgets are explicit and may produce partial result sets with completeness/truncation metadata; an unscanned tail is never treated as negative evidence. Search/filter chrome is sticky. Selecting a function pushes the Function Workspace; selecting an address moves to Code.

## Function Workspace

A function is one route with progressive tabs:

- **Overview** — plain-language role, core facts, next steps.
- **Pseudocode** — C-like reconstruction with copy/wrap/assembly jump where the architecture/product path supports it.
- **Flow** — CFG plus text representation.
- **Calls** — callers/callees.
- **Evidence** — observed facts vs inference.
- **Runtime** — runtime verification/debugger entry.

The default is Overview. Expert details are never required to understand the first answer.

## Evidence model

Evidence state and ranking score are separate dimensions.

Canonical UI semantic states:

- **Confirmed** — directly observed binary/runtime fact.
- **Likely** — inference supported by evidence.
- **Unverified** — insufficient evidence.
- **Contradicted** — evidence conflicts with the claim.

The component uses text, border/icon and color; color is not the only signal. Candidate ranking may still be shown where useful, but it must not be labelled or styled as certainty. The AI core's wire/evidence states remain a separate schema contract (`verified`, `supported`, `hypothesis`, `unknown`); UI presentation must not blur the two vocabularies.

## Overlay rules

### Screen

Persistent/deep navigation. Owns a route and participates in browser history.

### Inspector

Supplementary information for the selected function/instruction. Desktop/tablet may use a side pane; phone uses a full-screen push or dedicated route.

### Bottom Sheet

Transient, short tasks only: action picker, filter options, copy options. It must not become a nested navigation tree.

### Popover/Menu

A small set of context actions anchored to a control/selection.

### Dialog

Confirmation, destructive action or blocking decision only.

### Toast

Short-lived feedback only.

Legacy `Sheet` exists as a compatibility primitive while old low-level action UIs are migrated; canonical navigation never depends on its parent/forward chain.

## Responsive architecture

Canonical breakpoints are shared conceptually by CSS/JS:

- **Phone:** `< 600px`
- **Tablet:** `600–899px`
- **Desktop:** `>= 900px`

JavaScript avoids breakpoint-dependent behavior whenever CSS can express it.

### Phone

- persistent 4-item bottom navigation;
- 44px minimum touch target;
- address + assembly prioritized in ASM viewer;
- bytes are de-emphasized on narrow ASM layouts, remain available through Hex mode;
- code and pseudocode own their horizontal scrolling;
- Function Workspace is full route content, not nested sheets;
- graphs use the available screen and include a text representation;
- keyboard visibility uses `visualViewport` and `--ui-keyboard-inset`;
- bottom navigation withdraws while the soft keyboard is open.

### Landscape phone

On short landscape viewports the primary navigation becomes a compact right-side rail. Title/chrome height is reduced so the code/graph region retains useful vertical space.

### iPad / tablet

Tablet keeps the simple primary navigation but uses wider content/card grids and larger graph space. The architecture supports a contextual inspector without forcing a three-pane IDE on first-time users.

### Desktop

Canonical screen content is width-bounded for readability. Wider future Explorer/Main/Inspector layouts can be added without changing routes or domain APIs.

## Code viewer rules

- preserve existing row virtualization;
- body must never horizontally scroll;
- narrow widths prioritize address/mnemonic/operands;
- code-local horizontal scrolling is allowed;
- current row/selection remains domain/viewer state, not route DOM state;
- route/orientation changes must not rerun analysis merely to recreate UI.

## Mobile Safari rules

- use `100dvh`/`100svh` fallback strategy rather than `100vh` alone;
- use `env(safe-area-inset-*)` for fixed chrome;
- bridge `visualViewport.height/offsetTop` into CSS variables;
- keep focused inputs visible when the keyboard opens;
- clean up viewport listeners when the product shell is destroyed;
- retain Clipboard API and editable-textarea `execCommand('copy')` fallback;
- context menus must close on outside pointer, scroll and navigation/orientation changes.

## Design system

The canonical stylesheet stack is:

```text
css/ux.css        compatibility entrypoint only
  tokens.css      semantic tokens and z layers
  base.css        document/focus/reduced-motion foundations
  shell.css       application/navigation layout
  components.css  shared components
  mobile.css      phone/tablet responsive behavior
```

### Token domains

- color/surface/text/border/accent/danger/evidence;
- spacing;
- typography and line height;
- radius/elevation;
- 44px touch target;
- content/inspector widths;
- safe-area and keyboard inset;
- named z layers: base, sticky, inspector, backdrop, sheet, popover, dialog, toast.

Runtime inline style is reserved for geometry such as virtualization offsets, progress, graph transforms and measured viewport values.

## Interaction principles

1. Selection reveals contextual actions; global toolbars do not show irrelevant operations.
2. Back/forward means browser navigation for canonical screens.
3. Returning restores useful state (route, query, tab, list/code scroll) without retaining large DOM trees.
4. Long-running work names user-level phases rather than compiler implementation passes.
5. Empty/error states explain why no result exists and offer a next action.
6. Transient UI is destroyed on close; viewport/scroll observers have explicit cleanup.
7. Japanese is the primary copy target; layout must tolerate longer English labels and 200% text scaling.

## Test contract

`tests/ui/routes.mjs` validates route/action/migration invariants. `tests/ui/browser.mjs` exercises:

- Chromium viewport matrix: 375×667, 393×852, 430×932, 844×390, 744×1133, 1133×744, 1024×1366, 1440×900;
- WebKit: representative phone portrait/landscape, tablet and desktop;
- default **Code** route;
- persistent navigation/touch geometry;
- no body horizontal overflow;
- windowed Explorer and explicit partial-result behavior;
- Code route and existing virtualized viewer;
- Function Overview/Pseudocode/Flow/Calls/Evidence/Runtime;
- browser-back state restoration;
- keyboard inset behavior;
- optional screenshot artifacts for critical phone/tablet/desktop screens.

The existing `tests/browser.mjs` continues to cover real-analysis behavior, Clipboard fallback, context-menu dismissal and legacy compatibility while migration is in progress.
