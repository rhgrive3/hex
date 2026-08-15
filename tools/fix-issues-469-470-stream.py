from pathlib import Path

p = Path('worker.js')
s = p.read_text()

# The generic idempotence helper in the primary patch can see the already-patched
# /api/ai/turn cleanup and incorrectly skip the structurally identical cleanup
# inside handleGemini. Patch the legacy handler *within its own lexical range*.
gemini_start = s.index('async function handleGemini')
gemini_end = s.index('\nfunction isJsonRequest', gemini_start)
gemini = s[gemini_start:gemini_end]
legacy_sync_cleanup = """  const cleanup = () => {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', abortOnDisconnect);
  };
"""
legacy_async_cleanup = """  const cleanup = async () => {
    clearTimeout(timeout);
    request.signal.removeEventListener('abort', abortOnDisconnect);
    await releaseQuota();
  };
"""
if legacy_async_cleanup not in gemini:
    if legacy_sync_cleanup not in gemini:
        raise SystemExit('legacy cleanup patch anchor missing')
    gemini = gemini.replace(legacy_sync_cleanup, legacy_async_cleanup, 1)

# Any error path after quota acquisition must finish the lease before returning.
gemini = gemini.replace('cleanup();\n        return ', 'await cleanup();\n        return ')
gemini = gemini.replace('cleanup();\n      return ', 'await cleanup();\n      return ')
gemini = gemini.replace('cleanup();\n    return ', 'await cleanup();\n    return ')
gemini = gemini.replace('cleanup();\n    ', 'await cleanup();\n    ')
s = s[:gemini_start] + gemini + s[gemini_end:]

old_plain = """  const { readable, writable } = new TransformStream();
  const piping = upstream.body.pipeTo(writable, { signal: upstreamAbort.signal })
    .catch(() => {})
    .finally(cleanup);
  if (executionCtx && typeof executionCtx.waitUntil === 'function') executionCtx.waitUntil(piping);
  else void piping;
"""
old_flush = """  const { readable, writable } = new TransformStream({
    // Release the distributed concurrency lease before the client observes EOF.
    // Otherwise a client that immediately starts its next request after reading
    // the full stream can race the asynchronous pipeTo().finally() cleanup.
    async flush() { await cleanup(); },
  });
  const piping = upstream.body.pipeTo(writable, { signal: upstreamAbort.signal })
    .catch(async () => { await cleanup(); });
  if (executionCtx && typeof executionCtx.waitUntil === 'function') executionCtx.waitUntil(piping);
  else void piping;
"""
old_pull = """  const upstreamReader = upstream.body.getReader();
  const readable = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await upstreamReader.read();
        if (done) {
          // Release the distributed concurrency lease before downstream EOF.
          // An immediate next request cannot race a deferred cleanup callback.
          await cleanup();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        await cleanup();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await upstreamReader.cancel(reason); }
      finally { await cleanup(); }
    },
  });
"""
new = """  const upstreamReader = upstream.body.getReader();
  const readable = new ReadableStream({
    start(controller) {
      return (async () => {
        try {
          while (true) {
            const { done, value } = await upstreamReader.read();
            if (done) break;
            controller.enqueue(value);
          }
          // Producer completion owns the lease lifecycle. Release before close
          // so downstream EOF is a strict happens-after edge from quota cleanup.
          await cleanup();
          controller.close();
        } catch (error) {
          await cleanup();
          controller.error(error);
        }
      })();
    },
    async cancel(reason) {
      try { await upstreamReader.cancel(reason); }
      finally { await cleanup(); }
    },
  });
"""
if new not in s:
    for old in (old_pull, old_flush, old_plain):
        if old in s:
            s = s.replace(old, new, 1)
            break
    else:
        raise SystemExit('stream lifecycle patch anchor missing')

# Fail the patch immediately if the legacy route still contains a synchronous
# cleanup or a pipeTo().finally(cleanup) lifecycle.
legacy = s[s.index('async function handleGemini'):s.index('\nfunction isJsonRequest', s.index('async function handleGemini'))]
if 'const cleanup = () =>' in legacy:
    raise SystemExit('legacy cleanup remained synchronous')
if 'await releaseQuota();' not in legacy:
    raise SystemExit('legacy cleanup does not release quota')
if '.finally(cleanup)' in legacy:
    raise SystemExit('legacy stream still defers cleanup to pipeTo.finally')

p.write_text(s)
