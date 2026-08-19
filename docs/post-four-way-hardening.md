# Post-four-way hardening — historical integration report

> **Status: HISTORICAL SNAPSHOT.**  
> **Original report:** [`archive/ui/post-four-way-hardening.md`](archive/ui/post-four-way-hardening.md)  
> **Current UI contract:** [`ui-information-architecture.md`](ui-information-architecture.md)

This document originally recorded the merged Decompiler, Runtime, Recognition/Knowledge and canonical UI hardening pass. Its correctness and regression lessons remain useful, but several scale statements describe that snapshot rather than the current product contract.

In particular, the historical report says that all ~100k–300k functions remain reachable without truncation and that string search no longer hard-caps matches after materialization. Current product code intentionally applies explicit bounded work instead of pretending an unscanned tail is negative evidence: the unfiltered Explorer source is budgeted (`EXPLORER_SOURCE_LIMIT`, currently 50,000 in `js/ui/product.js`), and interactive function/string queries use bounded result limits (currently 200 by default in the product/query path). Partial results carry completeness/truncation metadata and the UI states that unscanned regions are not “no match”.

The important invariant is therefore **bounded, explicit partiality**, not “no cap”. Source/tests are authoritative for the exact current budget values.

The original hardening report is preserved unchanged at the archive path above.
