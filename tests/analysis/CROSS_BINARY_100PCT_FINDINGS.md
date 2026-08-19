# Cross-binary sub-100% accuracy investigation

Analysis-only report for draft PR #999 / branch `analysis/cross-binary-100pct`.

The branch is pinned against PR #996 final head `a1119c0a4d1c8476ab5f2460e35e2b7f4a211f58`. It is disposable and must not be merged as a production change. Unrelated workflows were removed on this branch and the remaining Cross-binary workflow is parked after evidence collection.

## Baseline

After the PR #996 xref repair, string xrefs are 100% on all three binaries. Remaining sub-100 features are:

- BattleCats: `funcs-guess` only, F1 `0.9968745131640442`.
- TsumTsum:
  - `funcs-guess` `0.9941073795556256`
  - `kinds` `0.9994435685801725`
  - `refs` `0.9999984721791462`
  - `objc` `0.9995778096766023`
  - `selffield` `0.9987234042553191`
  - `apimeaning` `0.9984817571914346`
  - `summary` `0.995`
  - `pseudoc` `0.9983017952450267`
- YWP:
  - `funcs-guess` `0.9747791554692281`
  - `kinds` `0.999957457670382`
  - `apimeaning` `0.9983282246187818`
  - `pseudoc` `0.9991771804717499`

## 1. `funcs-guess`: real heuristic defect, dominated by circular metadata evidence in YWP

### Exact baseline counts

- BattleCats: TP 102383 / FP 173 / FN 469.
- TsumTsum: TP 151496 / FP 804 / FN 992.
- YWP: TP 293081 / FP 14453 / FN 713; precision 95.3004%, recall 99.7573%.

YWP false positives are overwhelmingly immediately after an indirect `br`:

- after `br`: 10536 FP
- after direct `b`: 3579 FP
- after `ret`: 233 FP

### Hardened evidence classification

The YWP false-positive population was tagged with the exact `__functionEvidence()` signals that allow each candidate through `guessFunctionsHardened()`.

Dominant cohort:

- mask 131 = `data + structured + indirectTerminalStart`
- TP 125
- FP 9995
- precision of this evidence combination: ~1.235%

By contrast:

- `data + structured + indirectTerminalStart + indirectThunk`
- TP 2319
- FP 0

This shows that the `indirectThunk` signal is genuinely discriminative, while `data + structured + immediately-after-BR` is not.

### Provenance proof

The broad metadata source was independently reconstructed from the binary, not inferred from the worker result.

For mask 131:

- 125 / 125 TP are members of the broad image-relative candidate set.
- 9995 / 9995 FP are members of the broad image-relative candidate set.
- 0 / 125 TP and 0 / 9995 FP are field-relative metadata candidates.

The source is the `__DATA_CONST,__const` raw-u32 scan in `__functionEvidence()`: every 4-byte word is interpreted as `imageBase + uint32`, and any aligned value landing in executable `__text` becomes an `imageRelativeCodeCandidate`.

Later, the code promotes an image-relative candidate to generic `structured` evidence solely because it is immediately after an indirect branch:

```js
for (const target of imageRelativeCodeCandidates) {
  if (indirectTerminalStarts.has(target) || trapTerminalStarts.has(target)) structured.add(target);
}
```

Then `guessFunctionsHardened()` treats `structured` as a strong independent signal. The same physical fact is therefore effectively counted twice:

1. candidate happens to be immediately after `br`;
2. that same `br` fact promotes a broad raw-u32 candidate to `structured`;
3. `structured` is then treated as independent strong evidence.

This is circular evidence, not independent corroboration.

### Rejected fixes

#### Reject all post-branch candidates

Unsafe. Real functions are frequently physically adjacent to `b`, `br`, and `ret`. For example, dropping all direct-`b` successors destroys tens of thousands of true BattleCats starts.

#### Remove the `ADRP -> LOAD -> LOAD` global-dispatch heuristic

Measured A/B:

- BattleCats: F1 worsened from ~99.687% to ~99.675% (26 TP lost, no FP removed).
- TsumTsum: F1 worsened from ~99.411% to ~99.400% (35 TP lost, only 1 FP removed).
- YWP: only 49 FP removed.

Not the root cause.

#### Reject every `data + structured + indirectTerminalStart` candidate lacking another bit

Also unsafe across binaries. Measured A/B:

- BattleCats: `0.9968745132 -> 0.9967377544`
- TsumTsum: `0.9941073796 -> 0.9923087542`
- YWP: `0.9747791555 -> 0.9910806262`

It fixes the YWP symptom but throws away legitimate `structured` metadata candidates in the other binaries. The problem is not `structured` globally; it is loss of provenance inside `structured`.

### Correct production repair shape

Do not add another broad opcode filter. Preserve evidence provenance.

Recommended design:

1. Split `structured` into provenance-aware categories, e.g.:
   - exact initializer / ObjC metadata
   - validated vtable metadata
   - validated field-relative metadata
   - broad image-relative raw-u32 candidate
2. Never let `imageRelativeCodeCandidate + indirectTerminalStart` become an independent `strong` signal by itself.
3. Treat broad image-relative entries as weak candidates unless corroborated by an actually independent signal such as:
   - unwind metadata
   - direct call target
   - recognized function prologue
   - exact metadata
   - validated indirect/repeated thunk shape
   - a separately proven function-boundary/CFG fact
4. Prefer replacing the raw `__DATA_CONST,__const` u32 sweep with parsers for known relative-pointer metadata layouts. A random 32-bit word that happens to land inside a 40 MB text range is not metadata proof.
5. For the remaining 125 real YWP starts in the ambiguous cohort, do not recover them by reintroducing the circular rule. Add a second structural signal (validated metadata layout or CFG boundary evidence).

This should remove the 9995 dominant FPs without sacrificing the real vtable/ObjC structured starts that caused the cross-binary regression in the generic-filter A/B.

`funcs-guess` is the only area where literal 100.000% is not a realistic generic target without using exact `LC_FUNCTION_STARTS` or substantially richer metadata/CFG reasoning. The correct objective is high precision and recall without fixture-specific overfitting.

## 2. `kinds`: mixture of scorer semantics and real decoder gaps

### Scorer/expectation mismatches

TsumTsum contains three `bics ... xzr/wzr` cases. These are TST-style flag-only operations; Hex classifying them as `CMP` is semantically reasonable, while the current mnemonic table expects `LOGIC`.

TsumTsum also has one literal load:

- `ldr x24, #0x1018edb30`

Hex correctly classifies it as `LITERAL`; the scorer expects ordinary `LOAD` because it keys only from the Capstone mnemonic.

YWP has one analogous `bics xzr,...` scorer mismatch.

The scalar kind scorer should also explicitly decide whether SVE is in scope. Tsum's `add z9.b, p1/m, z9.b, z30.b` is currently judged as scalar `ARITH` even though existing exclusions already skip other vector operand forms.

### Real decoder gaps

TsumTsum actual gaps:

- `ror` immediate: 7 samples
- `extr`: 2 samples
- `udf #0`: 3 samples
- `fcvtzu ..., #scale`: 1 sample
- SVE `add` if SVE is intentionally in scope: 1 sample

YWP actual gap:

- `extr x13, x2, x17, #0x3f`: 1 sample

`Words.isShiftOp()` recognizes bitfield and variable shifts (`lslv/lsrv/asrv/rorv`) but not the extract encoding used by `EXTR` / immediate `ROR` aliases.

Repair:

- add EXTR encoding recognition to `SHIFT`; ROR-immediate follows as an alias of EXTR;
- classify UDF as `TRAP`;
- fix the fixed-point FP-convert mask for scaled `FCVTZU`;
- either add SVE arithmetic classification deliberately or exclude SVE from this scalar accuracy feature.

Do not change `BICS xzr/wzr` or literal-LDR product semantics just to satisfy the mnemonic-derived scorer.

## 3. TsumTsum `refs`: one oracle false positive

Only one miss exists:

- site `0x10195384c`
- instruction `add w4, w8, #0xeeb`
- oracle target `0x49328eeb`

The surrounding stream contains Capstone skipdata (`.byte`) and the target is not a plausible mapped 64-bit Mach-O address.

Root cause in `tests/oracle.py`:

- `reg_x()` aliases `w8` and `x8` to one provenance bucket;
- ADRP provenance is allowed to flow into a 32-bit `add w...`;
- skipdata/undecodable bytes do not clear stale ADRP state.

Repair the oracle, not production:

1. clear address provenance on skipdata/undecodable barriers;
2. require 64-bit X-register operands for ADRP+ADD address construction;
3. validate reconstructed targets against mapped Mach-O VM ranges before adding them to `adrTargets`.

Expected result: Tsum `refs` becomes 100% without changing Hex.

## 4. TsumTsum `objc` / `selffield`: 15 oracle-invalid Swift ivar offsets

All 15 mismatches are Swift-mangled classes whose oracle offsets are physically impossible (millions/billions of bytes while class `instanceSize` is only tens/hundreds of bytes).

Example observed during diagnostics: an instance size around 104 bytes paired with an oracle ivar offset around 2.56 billion.

Hex already applies a sanity check in `ivarOffset()` and returns unknown for impossible offsets (`> 0x100000`). The Python oracle does not.

Repair the oracle/scorer:

- reject ivar offsets beyond class `instanceSize` and a conservative global sanity cap;
- treat runtime-resolved Swift ivar offsets as unknown when they cannot be statically resolved;
- only score exact field offsets when the oracle offset is trusted.

Expected result: both `objc` and `selffield` reach 100% without weakening product validation.

## 5. TsumTsum `summary`: scorer bug, 199/200

Only failing sample:

- `-[FBAdChoicesContentView layout]`
- expected meaningful call includes selector `new`
- produced story visibly contains `「new」を呼ぶ`

The scorer refuses literal matching for names shorter than four characters:

```js
if (core.length >= 4 && text.includes(core)) ...
```

Repair:

- retain the >=4 rule for loose substring matching;
- additionally allow exact quoted/boundary-safe selector matching for short names such as `new`.

Expected result: 200/200.

## 6. `apimeaning`: real API knowledge-table coverage gap

The metric counts only actually-called stubs, so the remaining misses are meaningful catalog holes.

TsumTsum:

- 543224 / 544050 call occurrences known
- 826 missing occurrences
- 185 unique unknown APIs
- common families: OpenGL ES, libc/POSIX, stdio/math
- examples: `_glGetUniformLocation`, `_glVertexAttribPointer`, `_strspn`, `___maskrune`, `_fcntl`, `_glBindBuffer`, `_fflush`, `_fileno`, `_glBufferData`, `_kevent`, `_fstat`.

YWP:

- 541630 / 542537 known
- 907 missing occurrences
- 188 unique unknown APIs
- common families: nanopb, OpenGL ES, libc/POSIX/math
- examples: `_pb_decode`, `_pb_istream_from_buffer`, `_pb_read`, `_glUniformMatrix4fv`, `_atof`, `_pb_encode_tag_for_field`, `_pb_encode_submessage`, `_glUniform1i`.

Repair:

- add truthful ABI-aware entries to `PRECISE_API_TABLE` / `API_TABLE` for those families;
- do not add a catch-all `apiInfo()` fallback merely to make the metric 100%, because the current metric only checks non-null semantic knowledge and a generic fallback would game it.

Also consider strengthening the metric so a generic category does not score the same as precise API semantics.

## 7. `pseudoc`: real decompiler translation gaps

TsumTsum untranslated sampled instructions:

- `fcvtas x1, d0`
- `movi v0.4h, #1, lsl #8`
- `fccmp s0, s1, #0, pl`
- `fcsel s0, s0, s10, mi`
- `fcsel s0, s1, s0, mi`
- `rev x9, x9`
- `rev x20, x10`

YWP:

- `movi v0.4h, #1, lsl #8`
- two `fcsel` cases

Repair semantic handlers, not formatting:

- `FCSEL`: floating conditional select expression;
- `REV`: width-correct byte-swap expression/intrinsic;
- `FCVTAS`: signed FP-to-int conversion with ARM rounding semantics;
- vector `MOVI`: vector immediate construction;
- `FCCMP`: model conditional floating-point NZCV updates before emitting conditions.

The current safe `__asm(...)` fallback is correct behavior until those semantics are implemented; do not suppress it cosmetically.

## Recommended implementation order

1. Fix accuracy/oracle bugs first (`refs`, Swift ivars, `summary`, mnemonic expectation aliases/SVE scope). These remove false negatives in the benchmark without touching product behavior.
2. Add ARM64 decoder coverage (`EXTR/ROR`, UDF, scaled FCVTZU; SVE only if explicitly in scope).
3. Add pseudocode semantics (`FCSEL`, `REV`, `FCVTAS`, `MOVI`, `FCCMP`).
4. Expand API semantic tables with precise OpenGL/POSIX/nanopb entries.
5. Refactor `__functionEvidence()` to preserve structured-evidence provenance and eliminate the raw image-relative + indirect-BR circular promotion. Validate this separately across all three binaries before merging.
6. Only after those changes re-run the full Cross-binary gate. Do not weaken thresholds or current-main baselines.

## Evidence runs / probes retained on this analysis branch

Key custom probes:

- `tests/analysis/cross-binary-diagnose.mjs`
- `tests/analysis/kind-mismatch-probe.mjs`
- `tests/analysis/function-guess-filter-probe.mjs`
- `tests/analysis/function-cohort-ab.mjs`
- `tests/analysis/function-evidence-probe.mjs`
- `tests/analysis/function-structured-provenance.mjs`

Notable GitHub Actions runs:

- Full isolated baseline diagnostics: Cross-binary run #2385 and follow-up focused diagnostics.
- Function evidence classification: run `32232337885` / #2448.
- Generic independent-evidence A/B across all three binaries: run `32232646106` / #2454.
- YWP structured-provenance proof: run `32232987419` / #2458.

Rejected experiments and analysis-only wrappers remain as evidence under `js/worker-analysis-*.js`; `js/worker.js` itself has been restored to the PR #996 production entrypoint and the analysis workflow is parked.
