import assert from "node:assert/strict";
import { loadPlaywright, servePhase4Root } from "./browser-support.mjs";

const playwright = await loadPlaywright();
if (!playwright) {
  const message = "phase4 backend conformance: Playwright unavailable";
  if (process.env.CI) { console.error(message); process.exit(1); }
  console.log(`${message} (SKIP outside CI)`);
  process.exit(0);
}

const server = await servePhase4Root();
const browser = await playwright.chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage();
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async () => {
    const { MemoryArtifactBackend, IndexedDbArtifactBackend } = await import("/js/core/artifacts/index.js");
    const { runArtifactBackendContract } = await import("/tests/phase4/store/backend-contract.js");

    await runArtifactBackendContract({
      name: "memory",
      createBackend: async () => new MemoryArtifactBackend(),
    });

    let dbCounter = 0;
    await runArtifactBackendContract({
      name: "indexeddb",
      createBackend: async () => {
        const dbName = `hex-p4-conf-${Date.now()}-${++dbCounter}`;
        return new IndexedDbArtifactBackend({ dbName });
      },
      destroyBackend: async (backend) => {
        const dbName = backend.dbName;
        if (dbName) {
          await new Promise((resolve) => {
            const req = indexedDB.deleteDatabase(dbName);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
          });
        }
      },
    });

    return { memory: "pass", indexeddb: "pass" };
  });

  assert.equal(result.memory, "pass");
  assert.equal(result.indexeddb, "pass");
  console.log("phase4 backend conformance: PASS");
} finally {
  await browser.close();
  server.close();
}
