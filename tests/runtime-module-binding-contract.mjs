import assert from "node:assert/strict";
import fs from "node:fs";
import {
  hasProvenRuntimeStaticIdentity,
  normalizeRuntimeModuleBinding,
} from "../js/runtime/module-binding.js";
import { DebugAdapterRuntimeProvider } from "../js/runtime/provider.js";
import { DebuggerProvider } from "../js/runtime/debugger-provider.js";
import { InstrumentationProvider } from "../js/runtime/instrumentation-provider.js";
import { DebugAdapterError } from "../js/debug/adapter.js";

console.log("Testing RuntimeModuleBinding contract and trust rules...");

// 1. exact state trusts binary identity
{
  const mod = {
    bindingKey: "mod1",
    base: 0x1000n,
    size: 0x2000n,
    binaryId: "bin_1",
    sliceId: "slice_1",
    imageId: "image_1",
    identityState: "exact",
  };
  const norm = normalizeRuntimeModuleBinding(mod);
  assert.equal(norm.binaryId, "bin_1");
  assert.equal(norm.sliceId, "slice_1");
  assert.equal(norm.imageId, "image_1");
  assert.equal(norm.identityState, "exact");
  console.log("  ok 1 exact state trusts binary identity");
}

// 2. resolved state trusts binary identity
{
  const mod = {
    bindingKey: "mod2",
    binaryId: "bin_2",
    identityState: "resolved",
  };
  const norm = normalizeRuntimeModuleBinding(mod);
  assert.equal(norm.binaryId, "bin_2");
  assert.equal(norm.identityState, "resolved");
  console.log("  ok 2 resolved state trusts binary identity");
}

// 3. explicit evidence trusts binary identity
{
  const mod = {
    bindingKey: "mod3",
    binaryId: "bin_3",
    identityEvidenceIds: ["ev_1"],
  };
  const norm = normalizeRuntimeModuleBinding(mod);
  assert.equal(norm.binaryId, "bin_3");
  assert.equal(norm.identityState, "resolved");
  console.log("  ok 3 explicit evidence trusts binary identity");
}

// 4. binaryId alone is not proof
{
  const mod = {
    bindingKey: "mod4",
    binaryId: "bin_4",
  };
  const norm = normalizeRuntimeModuleBinding(mod);
  assert.equal(norm.binaryId, null);
  assert.equal(norm.sliceId, null);
  assert.equal(norm.imageId, null);
  assert.equal(norm.identityState, "unresolved");
  console.log("  ok 4 binaryId alone is not proof");
}

// 5. slice/image without trusted binary are discarded
{
  const mod = {
    bindingKey: "mod5",
    sliceId: "slice_5",
    imageId: "image_5",
    identityState: "exact",
  };
  const norm = normalizeRuntimeModuleBinding(mod);
  assert.equal(norm.binaryId, null);
  assert.equal(norm.sliceId, null);
  assert.equal(norm.imageId, null);
  assert.equal(norm.identityState, "unresolved");
  console.log("  ok 5 slice/image without binary discarded");
}

// 6. UUID/build identity is not proof
{
  const mod = {
    bindingKey: "mod6",
    uuid: "1234",
    buildIdentity: "build_1",
    path: "/bin/foo",
    staticBase: 0x1000n,
  };
  const norm = normalizeRuntimeModuleBinding(mod);
  assert.equal(norm.binaryId, null);
  assert.equal(norm.identityState, "unresolved");
  console.log("  ok 6 UUID/build identity is not proof");
}

// 7. arbitrary identity state is not proof
{
  for (const st of ["heuristic", "candidate", "partial", "unknown"]) {
    const mod = { bindingKey: "mod7", binaryId: "bin_7", identityState: st };
    const norm = normalizeRuntimeModuleBinding(mod);
    assert.equal(norm.binaryId, null);
    assert.equal(norm.identityState, "unresolved");
  }
  console.log("  ok 7 arbitrary identity state is not proof");
}

// 8. evidence list copied/frozen
{
  const ev = ["ev_1", "ev_2"];
  const mod = { bindingKey: "mod8", identityEvidenceIds: ev };
  const norm = normalizeRuntimeModuleBinding(mod);
  ev.push("ev_3");
  assert.deepEqual([...norm.identityEvidenceIds], ["ev_1", "ev_2"]);
  assert.ok(Object.isFrozen(norm.identityEvidenceIds));
  console.log("  ok 8 evidence list copied and frozen");
}

// 9. result object frozen
{
  const mod = { bindingKey: "mod9" };
  const norm = normalizeRuntimeModuleBinding(mod);
  assert.ok(Object.isFrozen(norm));
  assert.throws(() => { norm.bindingKey = "other"; });
  console.log("  ok 9 result object frozen");
}

// 10. exact fallback fields
{
  const mod1 = { bindingKey: "k", base: 10n, size: 20n, imageBase: 30n, name: "foo", uuid: "u1" };
  const norm1 = normalizeRuntimeModuleBinding(mod1);
  assert.equal(norm1.runtimeBase, 10n);
  assert.equal(norm1.runtimeSize, 20n);
  assert.equal(norm1.staticBase, 30n);
  assert.equal(norm1.pathHint, "foo");
  assert.equal(norm1.buildIdentity, "u1");

  const mod2 = { bindingKey: "k", runtimeBase: 1n, runtimeSize: 2n, staticBase: 3n, pathHint: "p", buildIdentity: "b" };
  const norm2 = normalizeRuntimeModuleBinding(mod2);
  assert.equal(norm2.runtimeBase, 1n);
  assert.equal(norm2.runtimeSize, 2n);
  assert.equal(norm2.staticBase, 3n);
  assert.equal(norm2.pathHint, "p");
  assert.equal(norm2.buildIdentity, "b");
  console.log("  ok 10 exact fallback precedence");
}

// 11. loadedSequence omitted when unspecified
{
  const norm = normalizeRuntimeModuleBinding({ bindingKey: "k" });
  assert.equal("loadedSequence" in norm, false);
  console.log("  ok 11 loadedSequence omitted when unspecified");
}

// 12. loadedSequence preserved when supplied
{
  const norm0 = normalizeRuntimeModuleBinding({ bindingKey: "k" }, { loadedSequence: 0 });
  assert.equal(norm0.loadedSequence, 0);
  const norm1 = normalizeRuntimeModuleBinding({ bindingKey: "k" }, { loadedSequence: 42 });
  assert.equal(norm1.loadedSequence, 42);
  console.log("  ok 12 loadedSequence preserved when supplied");
}

// 13. empty binding key rejected
{
  assert.throws(() => normalizeRuntimeModuleBinding({}), DebugAdapterError);
  assert.throws(() => normalizeRuntimeModuleBinding({ bindingKey: "" }), DebugAdapterError);
  assert.throws(() => normalizeRuntimeModuleBinding({ bindingKey: "   " }), DebugAdapterError);
  console.log("  ok 13 empty binding key rejected");
}

// 14. provider bootstrap parity
{
  const fakeAdapter = {
    id: "stub-adapter",
    kind: "debugger",
    capabilities: { modules: true },
    async connect() {},
    async disconnect() {},
    async getModules() {
      return [{ id: "modA", base: 0x1000n, size: 0x2000n, binaryId: "bin_a", identityState: "exact" }];
    },
  };
  const provider = new DebugAdapterRuntimeProvider(fakeAdapter);
  const session = await provider.openSession({ binaryId: "bin_test" });
  const binding = session.modules.get("modA");
  assert.ok(binding);
  assert.equal(binding.binaryId, "bin_a");
  assert.equal(binding.identityState, "exact");
  await session.close();
  console.log("  ok 14 provider bootstrap parity");
}

// 15. debugger module-load parity
{
  let eventHandler;
  const fakeAdapter = {
    id: "stub-dbg",
    kind: "debugger",
    capabilities: {},
    async connect() {},
    async disconnect() {},
    onEvent(fn) { eventHandler = fn; return () => {}; },
  };
  const provider = new DebuggerProvider(fakeAdapter);
  const session = await provider.openSession({ binaryId: "bin_test" });
  eventHandler({
    runtimeSessionId: session.runtimeSessionId,
    providerId: session.providerId,
    kind: "module-load",
    sequence: 12,
    payload: {
      module: { id: "modB", base: 0x3000n, size: 0x1000n, binaryId: "bin_b", identityState: "resolved" },
    },
  });
  const binding = session.modules.get("modB");
  assert.ok(binding);
  assert.equal(binding.binaryId, "bin_b");
  assert.equal(binding.identityState, "resolved");
  assert.equal(binding.loadedSequence, 12);
  await session.close();
  console.log("  ok 15 debugger module-load parity");
}

// 16. instrumentation bootstrap parity
{
  const fakeBackend = {
    async connect() {},
    async disconnect() {},
    async getModules() {
      return [{ id: "modC", base: 0x4000n, size: 0x5000n, binaryId: "bin_c", identityState: "exact" }];
    },
  };
  const provider = new InstrumentationProvider(fakeBackend);
  const session = await provider.openSession({ binaryId: "bin_test" });
  const binding = session.modules.get("modC");
  assert.ok(binding);
  assert.equal(binding.binaryId, "bin_c");
  assert.equal(binding.identityState, "exact");
  await session.close();
  console.log("  ok 16 instrumentation bootstrap parity");
}

// 17. untrusted module parity across all three callers
{
  const unproven = { id: "unproven", base: 0x1000n, size: 0x1000n, binaryId: "bin_x" };
  const n = normalizeRuntimeModuleBinding(unproven, { bindingKey: "unproven" });
  assert.equal(n.binaryId, null);
  assert.equal(n.identityState, "unresolved");
  console.log("  ok 17 untrusted module parity");
}

// 18. proven module parity across all three callers
{
  const proven = { id: "proven", base: 0x1000n, size: 0x1000n, binaryId: "bin_y", identityState: "exact" };
  const n = normalizeRuntimeModuleBinding(proven, { bindingKey: "proven" });
  assert.equal(n.binaryId, "bin_y");
  assert.equal(n.identityState, "exact");
  console.log("  ok 18 proven module parity");
}

// Static guard
{
  const files = [
    "/workspaces/hex/js/runtime/provider.js",
    "/workspaces/hex/js/runtime/debugger-provider.js",
    "/workspaces/hex/js/runtime/instrumentation-provider.js",
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    assert.ok(!src.includes("hasProvenStaticIdentity"), `Found duplicate hasProvenStaticIdentity in ${f}`);
  }
  console.log("  ok static guard passed");
}

console.log("All RuntimeModuleBinding contract tests PASS!");
