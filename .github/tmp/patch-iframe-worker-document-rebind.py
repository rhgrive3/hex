from pathlib import Path
import sys


def replace_once(path, old, new):
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one patch target in {path}, got {count}")
    target.write_text(text.replace(old, new, 1))


stage = sys.argv[1] if len(sys.argv) > 1 else ""
if stage == "test":
    path = "tests/dev-agent/iframe-worker-pool.mjs"
    replace_once(
        path,
        """async function testCrossOriginProjectUrlFailsClosed() {\n""",
        """async function testNavigationDocumentReplacementRebindsRuntime() {\n  const initialDocument = { readyState: 'complete', composer: false, location: { href: 'about:blank' } };\n  const committedDocument = { readyState: 'complete', composer: true, location: { href: 'https://chatgpt.com/' } };\n  let activeDocument = initialDocument;\n  const runtimes = [];\n  const frame = {\n    src: null, removed: false,\n    get contentDocument() { return activeDocument; },\n  };\n  const pool = new IframeWorkerPool({\n    maxWorkers: 1,\n    createFrame: () => ({\n      frame,\n      async navigate(href) {\n        frame.src = href;\n        // A real iframe exposes its initial about:blank Document before the\n        // first cross-document navigation commits a replacement Document.\n        setTimeout(() => { activeDocument = committedDocument; }, 0);\n      },\n      close() { frame.removed = true; },\n    }),\n    createWorkerRuntime: ({ slot, document }) => {\n      const runtime = fakeWorkerRuntime(slot, document);\n      runtime.boundDocument = document;\n      runtime.closed = false;\n      const close = runtime.close.bind(runtime);\n      runtime.close = () => { runtime.closed = true; close(); };\n      runtimes.push(runtime);\n      return runtime;\n    },\n    documentRef: new FakeDocument(),\n    cryptoRef: webcrypto,\n    location: { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com' },\n    sleep: async () => tick(),\n  });\n\n  const provisioned = await pool.provision({ size: 1, timeoutMs: 120 });\n  assert.equal(provisioned.readyCount, 1, 'the committed ChatGPT Document must become the authoritative Worker realm');\n  assert.equal(runtimes.length, 2, 'runtime must be rebound exactly once when navigation replaces the initial Document');\n  assert.equal(runtimes[0].boundDocument, initialDocument);\n  assert.equal(runtimes[0].closed, true, 'the runtime bound to initial about:blank must be retired');\n  assert.equal(runtimes[1].boundDocument, committedDocument);\n  pool.close();\n}\n\nasync function testCrossOriginProjectUrlFailsClosed() {\n""",
    )
    replace_once(
        path,
        """  create({ slot }) {\n    const factory = this;\n    const frame = {\n""",
        """  create({ slot }) {\n    const factory = this;\n    const contentDocument = { readyState: 'complete', composer: factory.composer };\n    const frame = {\n""",
    )
    replace_once(
        path,
        """        return this.src ? { readyState: 'complete', composer: factory.composer } : null;\n""",
        """        return this.src ? contentDocument : null;\n""",
    )
    replace_once(
        path,
        """await testBlockedEmbeddingIsReportedExactly();\nawait testCrossOriginProjectUrlFailsClosed();\n""",
        """await testBlockedEmbeddingIsReportedExactly();\nawait testNavigationDocumentReplacementRebindsRuntime();\nawait testCrossOriginProjectUrlFailsClosed();\n""",
    )
elif stage == "source":
    path = "js/userscript/dev/frame-mesh/iframe-worker-pool.js"
    replace_once(
        path,
        """      index, href, handle, runtime: null, client: null, ready: false, claimed: false, reserving: false,\n""",
        """      index, href, handle, runtime: null, runtimeDocument: null, client: null, ready: false, claimed: false, reserving: false,\n""",
    )
    replace_once(
        path,
        """      if (document) {\n        sameOriginSeen = true;\n        if (!slot.runtime) {\n          try {\n            slot.runtime = this.createWorkerRuntime({ slot: slot.index, frame: slot.handle.frame, document, now: this.now });\n            slot.client = slot.runtime?.coordinator || null;\n          } catch (error) { lastError = error; slot.runtime = null; slot.client = null; }\n        }\n        try { if (slot.runtime && slot.client && slot.runtime.ready()) return { ready: true }; }\n        catch (error) { lastError = error; }\n      }\n""",
        """      if (document) {\n        sameOriginSeen = true;\n        // An iframe starts with an initial about:blank Document. Setting src\n        // schedules a cross-document navigation, so the first reachable\n        // contentDocument can be transient. Never keep a Worker runtime bound\n        // to a Document that the frame has already replaced.\n        if (slot.runtime && slot.runtimeDocument !== document) closeRuntime(slot);\n        if (!slot.runtime) {\n          try {\n            slot.runtime = this.createWorkerRuntime({ slot: slot.index, frame: slot.handle.frame, document, now: this.now });\n            slot.runtimeDocument = slot.runtime ? document : null;\n            slot.client = slot.runtime?.coordinator || null;\n          } catch (error) { lastError = error; closeRuntime(slot); }\n        }\n        try { if (slot.runtime && slot.client && slot.runtime.ready()) return { ready: true }; }\n        catch (error) { lastError = error; }\n      }\n""",
    )
    replace_once(
        path,
        """function closeSlot(slot) {\n  try { slot.runtime?.close?.(); } catch { /* already closed */ }\n  try { slot.handle?.close?.(); } catch { /* already detached */ }\n}\n""",
        """function closeRuntime(slot) {\n  try { slot.runtime?.close?.(); } catch { /* already closed */ }\n  slot.runtime = null;\n  slot.runtimeDocument = null;\n  slot.client = null;\n}\nfunction closeSlot(slot) {\n  closeRuntime(slot);\n  try { slot.handle?.close?.(); } catch { /* already detached */ }\n}\n""",
    )
    replace_once(
        path,
        """    index, handle: null, runtime: null, client: null, ready: false, claimed: false, reserving: false,\n""",
        """    index, handle: null, runtime: null, runtimeDocument: null, client: null, ready: false, claimed: false, reserving: false,\n""",
    )
else:
    raise SystemExit("usage: patch-iframe-worker-document-rebind.py test|source")
