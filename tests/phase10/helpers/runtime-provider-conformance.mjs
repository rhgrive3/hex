import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeEvent, createRuntimeEventBatch } from "../../../js/runtime/events.js";
import { hasProvenRuntimeStaticIdentity, normalizeRuntimeModuleBinding } from "../../../js/runtime/module-binding.js";

export function defineRuntimeProviderConformance(name, fixture) {
  test(`RuntimeProvider conformance [${name}]: stable provider identity and version`, async () => {
    const provider = await fixture.createProvider();
    const desc = provider.descriptor();
    assert.ok(desc && typeof desc === "object");
    assert.ok(typeof desc.id === "string" && desc.id.length > 0);
    assert.ok(typeof desc.version === "string" && desc.version.length > 0);
    assert.ok(Array.isArray(desc.facets));
  });

  test(`RuntimeProvider conformance [${name}]: stable session binding`, async () => {
    const provider = await fixture.createProvider();
    const binaryId = "bin_test_conf_" + name;
    const session1 = await provider.openSession({ binaryId });
    assert.equal(session1.providerId, provider.descriptor().id);
    assert.equal(session1.target.primaryBinaryId, binaryId);
    await session1.close();
  });

  if (fixture.requiresTarget !== false) {
    test(`RuntimeProvider conformance [${name}]: target identity is explicit and not guessed`, async () => {
      const provider = await fixture.createProvider();
      await assert.rejects(async () => {
        await provider.openSession({});
      }, (err) => err.code === "runtime-binary-identity-required");
    });
  }

  test(`RuntimeProvider conformance [${name}]: module binding trust integration (#1195)`, async () => {
    const unproven = { bindingKey: "m_unproven", binaryId: "bin_fake" };
    const proven = { bindingKey: "m_proven", binaryId: "bin_real", identityState: "exact" };
    assert.equal(hasProvenRuntimeStaticIdentity(unproven), false);
    assert.equal(hasProvenRuntimeStaticIdentity(proven), true);
    const normUnproven = normalizeRuntimeModuleBinding(unproven);
    const normProven = normalizeRuntimeModuleBinding(proven);
    assert.equal(normUnproven.binaryId, null);
    assert.equal(normProven.binaryId, "bin_real");
  });

  test(`RuntimeProvider conformance [${name}]: batch identity mismatch rejected (#1184)`, async () => {
    const e1 = createRuntimeEvent({ runtimeSessionId: "S1", providerId: "P1", sessionEpoch: 1, kind: "paused" });
    const e2 = createRuntimeEvent({ runtimeSessionId: "S2", providerId: "P1", sessionEpoch: 1, kind: "paused" });
    assert.throws(() => {
      createRuntimeEventBatch({ runtimeSessionId: "S1", providerId: "P1", sessionEpoch: 1, events: [e1, e2] });
    }, (err) => err.code === "runtime-event-batch-identity-mismatch");
  });
}
