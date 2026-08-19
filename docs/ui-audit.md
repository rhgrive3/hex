# Hex UI audit — historical pre-product-shell snapshot

> **Status: HISTORICAL AUDIT.**  
> **Original audit:** [`archive/ui/ui-audit-pre-diff-route.md`](archive/ui/ui-audit-pre-diff-route.md)  
> **Current route registry:** `js/ui/registry.js`  
> **Current UI contract:** [`ui-information-architecture.md`](ui-information-architecture.md)

The archived audit is the evidence record for the UI before and during the product-shell migration. Its 54-entry legacy-screen inventory and migration rationale remain useful historical material.

Do not use its “After: 10 canonical routes/workspaces” count as current truth. The current machine-testable registry includes **11** routes/workspaces because `/diff` is now a canonical route in addition to the ten routes listed by the historical audit. `js/ui/registry.js` is the owning source and must win over this snapshot whenever route inventory changes.

Likewise, any old migration wording that describes Investigate as the default landing screen is historical. The current product default route is `/code`.

The original audit is preserved unchanged at the archive path above.
