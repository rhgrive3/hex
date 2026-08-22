# Analysis cancellation and settlement contract

This document records the fail-closed contract for long-running local analysis.

- ChatGPT Web model generation may remain unbounded; deterministic local tools do not inherit that policy.
- Tool execution has a finite local deadline (`cheap` 20s, `medium` 45s, `expensive` 60s unless explicitly overridden within the registry cap).
- Function pinpoint analysis has its own finite guard and propagates `AbortSignal` into semantic analysis.
- Automatic field-access pinpointing batches the whole-region scan once per analysis burst and cancels the underlying request when its guard or parent signal aborts.
- Closing the automatic-analysis overview or an individual candidate view aborts the active analysis chain instead of only hiding its UI.
- `analyzeModelAt -> analyzeFunctionCached -> analyzeFunction -> Backend` preserves cancellation through chunk reads and long instruction loops.
- Backend cancellation settles the matching pending RPC locally. Worker `error`, `messageerror`, fatal messages, and synchronous `postMessage` failures also settle owned pending RPCs.
- Mapped `fetchChunk()` and `fieldAccessMany()` promises preserve the underlying `cancel()` hook.
- Generated userscript artifacts must be rebuilt after source reconciliation; CI is evaluated only on the resulting exact PR head.

Regression coverage lives in `tests/ai-analysis-boundary.mjs`, `tests/backend-disposal.mjs`, and `tests/ir-pinpoint-location.mjs`.
