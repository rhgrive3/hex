import assert from "node:assert/strict";

export async function runManagedFrontendContract({
  Frontend,
  fixture,
}) {
  // 1. Frontend metadata
  const frontend = new Frontend();
  assert.equal(frontend.id, fixture.id);
  assert.match(frontend.contractVersion, /^\d+\.\d+\.\d+$/);
  assert.match(frontend.semanticVersion, /^\d+\.\d+\.\d+$/);

  const frontend2 = new Frontend();
  assert.equal(frontend2.id, frontend.id);
  assert.equal(frontend2.contractVersion, frontend.contractVersion);
  assert.equal(frontend2.semanticVersion, frontend.semanticVersion);

  // 2. Input immutability at probe/open boundary
  const bytesForProbe = fixture.createBytes();
  const probeCopy = new Uint8Array(bytesForProbe);
  await frontend.probe(bytesForProbe);
  assert.deepEqual(bytesForProbe, probeCopy);

  const bytesForOpen = fixture.createBytes();
  const openCopy = new Uint8Array(bytesForOpen);
  const image = await frontend.open(bytesForOpen);
  assert.deepEqual(bytesForOpen, openCopy);

  // 3. Probe determinism
  const p1 = await frontend.probe(fixture.createBytes());
  const p2 = await frontend.probe(fixture.createBytes());
  assert.deepEqual(p1, p2);

  // 4. Open determinism for public identity fields
  const img1 = await frontend.open(fixture.createBytes());
  const img2 = await frontend.open(fixture.createBytes());
  assert.ok(img1.imageId && typeof img1.imageId === "string");
  assert.ok(img1.moduleId && typeof img1.moduleId === "string");
  assert.ok(img1.formatVersion !== undefined);
  assert.equal(img1.imageId, img2.imageId);
  assert.equal(img1.moduleId, img2.moduleId);
  assert.equal(img1.formatVersion, img2.formatVersion);

  // 5. Module enumeration
  const modules1 = [];
  for await (const m of frontend.enumerateModules(img1)) modules1.push(m);
  const modules2 = [];
  for await (const m of frontend.enumerateModules(img1)) modules2.push(m);
  assert.deepEqual(modules1, modules2);
  assert.equal(modules1.length, fixture.expectedModuleCount);
  for (const m of modules1) {
    assert.ok(m.id && typeof m.id === "string");
    assert.equal(m.imageId, img1.imageId);
  }

  // 6. Type enumeration
  const types1 = [];
  for await (const t of frontend.enumerateTypes(img1)) types1.push(t);
  const types2 = [];
  for await (const t of frontend.enumerateTypes(img1)) types2.push(t);
  assert.deepEqual(types1, types2);
  assert.ok(types1.length >= fixture.expectedMinimumTypeCount);
  for (const t of types1) {
    assert.ok(t.id && typeof t.id === "string");
    assert.equal(t.moduleId, img1.moduleId);
  }

  // 7. Method enumeration
  const methods1 = [];
  for await (const m of frontend.enumerateMethods(img1)) methods1.push(m);
  const methods2 = [];
  for await (const m of frontend.enumerateMethods(img1)) methods2.push(m);
  assert.deepEqual(methods1, methods2);
  assert.ok(methods1.length >= fixture.expectedMinimumMethodCount);
  const methodIdSet = new Set();
  for (const m of methods1) {
    assert.ok(m.id && typeof m.id === "string");
    assert.ok(m.name && typeof m.name === "string");
    assert.equal(m.moduleId, img1.moduleId);
    assert.ok(!methodIdSet.has(m.id), "Duplicate method ID: " + m.id);
    methodIdSet.add(m.id);
  }

  // 8. Decode context is mandatory
  const method = fixture.selectDecodableMethod(methods1);
  assert.ok(method, "Decodable method must be selected");
  await assert.rejects(async () => {
    await frontend.decodeMethod(method, {});
  });

  // 9. Decode stability
  const dec1 = await frontend.decodeMethod(method, { image: img1 });
  const dec2 = await frontend.decodeMethod(method, { image: img1 });
  assert.equal(dec1.methodId, method.id);
  assert.ok(Array.isArray(dec1.bundles));
  const proj = (d) => ({
    methodId: d.methodId,
    bundleCount: d.bundles.length,
    bundleKinds: d.bundles.map((b) => b.kind ?? b.mnemonic ?? null),
    completeness: d.bundles.map((b) => b.completeness ?? null),
  });
  assert.deepEqual(proj(dec1), proj(dec2));

  // 10. Validation-report shape
  const val1 = await frontend.validateMethod(dec1, { image: img1 });
  assert.equal(val1.targetId, dec1.methodId);
  assert.ok(typeof val1.status === "string" && val1.status.length > 0);
  assert.ok(val1.completeness && typeof val1.completeness === "object");
  assert.ok(typeof val1.completeness.structural === "string" && val1.completeness.structural.length > 0);
  assert.ok(typeof val1.completeness.specValidation === "string" && val1.completeness.specValidation.length > 0);
  assert.ok(typeof val1.completeness.semanticEffect === "string" && val1.completeness.semanticEffect.length > 0);

  // 11. Lift lifecycle
  const lifted1 = await frontend.liftMethod(dec1, val1, { image: img1 });
  assert.ok(lifted1 != null);
  assert.equal(lifted1.methodId, dec1.methodId);

  // 12. Repeatability from fresh bytes
  const imgFresh = await frontend.open(fixture.createBytes());
  const freshModules = [];
  for await (const m of frontend.enumerateModules(imgFresh)) freshModules.push(m);
  const freshTypes = [];
  for await (const t of frontend.enumerateTypes(imgFresh)) freshTypes.push(t);
  const freshMethods = [];
  for await (const m of frontend.enumerateMethods(imgFresh)) freshMethods.push(m);
  const freshMethod = fixture.selectDecodableMethod(freshMethods);
  const freshDec = await frontend.decodeMethod(freshMethod, { image: imgFresh });
  const freshVal = await frontend.validateMethod(freshDec, { image: imgFresh });
  const freshLift = await frontend.liftMethod(freshDec, freshVal, { image: imgFresh });

  const runProjection = (img, mods, typs, meths, dec, val, lft) => ({
    imageId: img.imageId,
    moduleId: img.moduleId,
    moduleIds: mods.map((m) => m.id),
    typeIds: typs.map((t) => t.id),
    methodIds: meths.map((m) => m.id),
    decodedMethodId: dec.methodId,
    validationTargetId: val.targetId,
    validationStatus: val.status,
    validationCompleteness: val.completeness,
    liftedMethodId: lft.methodId,
  });

  const pRun1 = runProjection(img1, modules1, types1, methods1, dec1, val1, lifted1);
  const pRun2 = runProjection(imgFresh, freshModules, freshTypes, freshMethods, freshDec, freshVal, freshLift);
  assert.deepEqual(pRun1, pRun2);
}
