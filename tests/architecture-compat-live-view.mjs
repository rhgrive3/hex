import fs from "node:fs";
import assert from "node:assert/strict";
import {
  architectureAdapter,
  registerArchitectureAdapter,
  ArchitectureAdapter,
  architecturePluginV2,
  architecturePluginsV2,
  ArchitecturePluginV2,
} from "../js/architecture/index.js";
import { registerArchitecturePlugin } from "../js/targets/architecture/index.js";

console.log("Testing ArchitectureAdapter live view over ArchitecturePluginV2...");

// Case 1 — built-ins are identical by ID
for (const plugin of architecturePluginsV2()) {
  const adapter = architectureAdapter(plugin.id);
  assert.equal(adapter.id, plugin.id);
  assert.equal(adapter.instructionAlignment, plugin.instructionAlignment);
  assert.equal(adapter.fixedInstructionSize, plugin.fixedInstructionSize);
  assert.equal(adapter.viewerCompatible, plugin.viewerCompatible);
  assert.equal(adapter.decode, plugin.decode);
  assert.equal(adapter.assemble, plugin.assemble);
}
console.log("  ok Case 1 built-ins parity");

// Case 2 — control-flow projection parity
for (const plugin of architecturePluginsV2()) {
  const adapter = architectureAdapter(plugin.id);
  const fakeInsn = { mnemonic: "ret" };
  assert.equal(adapter.controlFlow(fakeInsn), plugin.classifyControlFlow(fakeInsn));
}
console.log("  ok Case 2 control-flow projection parity");

// Case 3 — callKind/returnKind compatibility
{
  const arm = architectureAdapter("arm64");
  assert.equal(arm.callKind({ mnemonic: "bl" }), "call");
  assert.equal(arm.callKind({ mnemonic: "add" }), null);
  assert.equal(arm.returnKind({ mnemonic: "ret" }), "return");
  assert.equal(arm.returnKind({ mnemonic: "add" }), null);
  console.log("  ok Case 3 callKind/returnKind");
}

// Case 4 — repeated lookup is stable
{
  const a1 = architectureAdapter("arm64");
  const a2 = architectureAdapter("arm64");
  assert.strictEqual(a1, a2);
  console.log("  ok Case 4 repeated lookup is strict equal");
}

// Case 5 — normalization is shared
{
  const a1 = architectureAdapter("  ARM64  ");
  const a2 = architectureAdapter("arm64");
  assert.strictEqual(a1, a2);
  console.log("  ok Case 5 shared normalization");
}

// Case 6 — unknown fallback parity
{
  const unk = architectureAdapter("non-existent-arch");
  const unkPlugin = architecturePluginV2("unknown");
  assert.equal(unk.id, unkPlugin.id);
  console.log("  ok Case 6 unknown fallback parity");
}

// Case 7 — late canonical registration becomes immediately visible
{
  const testId = "test-arch-live-" + Date.now();
  registerArchitecturePlugin({
    id: testId,
    instructionAlignment: 4,
    fixedInstructionSize: 4,
    viewerCompatible: true,
  });
  const adapter = architectureAdapter(testId);
  assert.equal(adapter.id, testId);
  assert.equal(adapter.fixedInstructionSize, 4);
  console.log("  ok Case 7 late canonical registration immediately visible");
}

// Case 8 — canonical replacement invalidates projected identity
{
  const testId = "test-replace-live-" + Date.now();
  const p1 = registerArchitecturePlugin({ id: testId, instructionAlignment: 4, fixedInstructionSize: 4 });
  const a1 = architectureAdapter(testId);
  const p2 = registerArchitecturePlugin({ id: testId, instructionAlignment: 2, fixedInstructionSize: 2 }, { replace: true });
  const a2 = architectureAdapter(testId);
  assert.notStrictEqual(a1, a2);
  assert.equal(a2.fixedInstructionSize, 2);
  const a2_again = architectureAdapter(testId);
  assert.strictEqual(a2, a2_again);
  console.log("  ok Case 8 canonical replacement invalidation");
}

// Case 9 — legacy registration writes canonical registry
{
  const testId = "test-legacy-write-" + Date.now();
  registerArchitectureAdapter({ id: testId, instructionAlignment: 8, fixedInstructionSize: 8 });
  const plugin = architecturePluginV2(testId);
  assert.ok(plugin);
  assert.equal(plugin.id, testId);
  assert.equal(plugin.fixedInstructionSize, 8);
  console.log("  ok Case 9 legacy registration writes canonical");
}

// Case 10 — legacy duplicate rejection
{
  const testId = "test-legacy-dup-" + Date.now();
  registerArchitectureAdapter({ id: testId, instructionAlignment: 4 });
  assert.throws(() => registerArchitectureAdapter({ id: testId, instructionAlignment: 4 }), /architecture already registered/);
  console.log("  ok Case 10 legacy duplicate rejection");
}

// Case 11 — legacy replace updates canonical registry
{
  const testId = "test-legacy-replace-" + Date.now();
  registerArchitectureAdapter({ id: testId, instructionAlignment: 4, fixedInstructionSize: 4 });
  const a2 = registerArchitectureAdapter({ id: testId, instructionAlignment: 2, fixedInstructionSize: 2 }, { replace: true });
  assert.equal(a2.fixedInstructionSize, 2);
  assert.equal(architecturePluginV2(testId).fixedInstructionSize, 2);
  console.log("  ok Case 11 legacy replace updates canonical");
}

// Case 12 — legacy direct construction still works
{
  const custom = new ArchitectureAdapter({ id: "custom", fixedInstructionSize: 4, instructionAlignment: 4 });
  const row = custom.rowForAddress({ vmAddr: 0x1000n, size: 0x100n }, 0x1004n);
  assert.equal(row, 1);
  console.log("  ok Case 12 direct construction works");
}

// Case 13 — variable-width fallback remains unsupported for placement
{
  const custom = new ArchitectureAdapter({ id: "custom-var", fixedInstructionSize: null });
  const res = custom.validateInstructionPlacement({ vmAddr: 0x1000n, size: 0x100n }, 0x1000n, 4);
  assert.equal(res.ok, false);
  assert.equal(res.unsupported, true);
  console.log("  ok Case 13 variable-width placement unsupported");
}

// Case 14 — no registry snapshot remains in js/architecture/index.js
{
  const code = fs.readFileSync("/workspaces/hex/js/architecture/index.js", "utf8");
  assert.ok(!code.includes("const BUILTINS = new Map"));
  assert.ok(!code.includes("for (const plugin of architecturePluginsV2()) registerArchitectureAdapter"));
  console.log("  ok Case 14 no registry snapshot in source");
}

console.log("All architecture live view tests PASS!");
