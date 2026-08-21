import { loadPlaywright, servePhase4Root } from './browser-support.mjs';

const playwright = await loadPlaywright();
if (!playwright) {
  const message = 'phase4 browser persistence: Playwright unavailable';
  if (process.env.CI) { console.error(message); process.exit(1); }
  console.log(`${message} (SKIP outside CI)`);
  process.exit(0);
}

const server = await servePhase4Root();
const browser = await playwright.chromium.launch({ args:['--no-sandbox'] });
const page = await browser.newPage();
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil:'domcontentloaded' });
  const result = await page.evaluate(async () => {
    const {
      ArtifactHotCache,
      ArtifactStore,
      IndexedDbArtifactBackend,
      createArtifactDescriptor,
    } = await import('/js/core/artifacts/index.js');
    const { AnalysisScheduler } = await import('/js/core/scheduler/index.js');

    const dbName = 'hex-phase4-browser-reopen-v1';
    const deleteDb = () => new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('phase4-test-db-delete-blocked'));
    });
    await deleteDb();

    const descriptor = createArtifactDescriptor({
      binaryId:'bin_browser_fixture', sliceId:'slice_browser_fixture', entityId:'function_browser_fixture',
      artifactKind:'semantic-ir-v2', producerId:'phase4-browser-producer', producerVersion:'1',
      versions:{ loader:'fixture-loader-1', architectureSemantic:'arm64-2', abiSemantic:'aapcs64-1', semanticSchema:'2' },
      config:{ logicalInput:'same' },
    });

    let coldInvocations = 0;
    let store = new ArtifactStore({
      backend:new IndexedDbArtifactBackend({ dbName }),
      hotCache:new ArtifactHotCache({ maxBytes:4096, maxEntries:4 }),
    });
    let scheduler = new AnalysisScheduler({ store, maxConcurrency:1 });
    const cold = await scheduler.request({
      descriptor,
      priority:'foreground',
      produce:async () => { coldInvocations++; return { semantic:'payload', value:42, nested:{ b:2, a:1 } }; },
    });
    const coldCapabilities = store.capabilities();
    store.evictHot(descriptor.artifactId);
    await store.close();

    let warmInvocations = 0;
    store = new ArtifactStore({
      backend:new IndexedDbArtifactBackend({ dbName }),
      hotCache:new ArtifactHotCache({ maxBytes:4096, maxEntries:4 }),
    });
    scheduler = new AnalysisScheduler({ store, maxConcurrency:1 });
    const warm = await scheduler.request({
      descriptor,
      priority:'foreground',
      produce:async () => { warmInvocations++; return { shouldNotRun:true }; },
    });
    const warmCapabilities = store.capabilities();
    await store.close();
    await deleteDb();

    return {
      artifactId:descriptor.artifactId,
      coldInvocations,
      warmInvocations,
      coldReused:cold.reused,
      warmReused:warm.reused,
      warmSource:warm.source,
      equalPayload:JSON.stringify(cold.payload) === JSON.stringify(warm.payload),
      coldCapabilities,
      warmCapabilities,
    };
  });

  if (result.coldInvocations !== 1 || result.coldReused !== false) throw new Error(`cold production invalid: ${JSON.stringify(result)}`);
  if (result.warmInvocations !== 0 || result.warmReused !== true || result.warmSource !== 'persistent') throw new Error(`warm reopen did not reuse persistent artifact: ${JSON.stringify(result)}`);
  if (!result.equalPayload) throw new Error(`cold/warm payload mismatch: ${JSON.stringify(result)}`);
  if (!result.coldCapabilities.persistent || !result.warmCapabilities.persistent || !result.warmCapabilities.indexedDB) throw new Error(`IndexedDB capability not reported: ${JSON.stringify(result)}`);
  console.log(`PHASE4_BROWSER_REOPEN ${JSON.stringify({ artifactId:result.artifactId, coldProducerInvocationCount:result.coldInvocations, warmProducerInvocationCount:result.warmInvocations, coldReused:result.coldReused, warmReused:result.warmReused, warmSource:result.warmSource, equalPayload:result.equalPayload })}`);
  console.log(`phase4 browser persistence: PASS artifactId=${result.artifactId} coldProducerInvocations=${result.coldInvocations} warmProducerInvocations=${result.warmInvocations}`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
