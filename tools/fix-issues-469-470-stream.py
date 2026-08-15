from pathlib import Path

p = Path('worker.js')
s = p.read_text()
old = """  const { readable, writable } = new TransformStream();
  const piping = upstream.body.pipeTo(writable, { signal: upstreamAbort.signal })
    .catch(() => {})
    .finally(cleanup);
  if (executionCtx && typeof executionCtx.waitUntil === 'function') executionCtx.waitUntil(piping);
  else void piping;
"""
new = """  const { readable, writable } = new TransformStream({
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
if old not in s:
    if new in s:
        raise SystemExit(0)
    raise SystemExit('stream lifecycle patch anchor missing')
p.write_text(s.replace(old, new, 1))
