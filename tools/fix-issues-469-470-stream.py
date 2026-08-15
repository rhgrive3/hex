from pathlib import Path

p = Path('worker.js')
s = p.read_text()
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
if new in s:
    raise SystemExit(0)
for old in (old_pull, old_flush, old_plain):
    if old in s:
        p.write_text(s.replace(old, new, 1))
        break
else:
    raise SystemExit('stream lifecycle patch anchor missing')
