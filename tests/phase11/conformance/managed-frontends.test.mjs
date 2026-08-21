import assert from "node:assert/strict";
import { WasmFrontend } from "../../../js/managed/wasm/frontend.js";
import { DexFrontend } from "../../../js/managed/dex/frontend.js";
import { JvmFrontend } from "../../../js/managed/jvm/frontend.js";
import { CilFrontend } from "../../../js/managed/cil/frontend.js";

import { fixture as wasmFixture } from "../fixtures/wasm.mjs";
import { fixture as dexFixture } from "../fixtures/dex.mjs";
import { fixture as jvmFixture } from "../fixtures/jvm.mjs";
import { fixture as cilFixture } from "../fixtures/cil.mjs";

import { runManagedFrontendContract } from "./managed-frontend-contract.mjs";

console.log("[phase11] running managed frontends conformance contract tests...");

console.log("  testing WasmFrontend conformance...");
await runManagedFrontendContract({ Frontend: WasmFrontend, fixture: wasmFixture });
console.log("    ok wasm conformance passed");

console.log("  testing DexFrontend conformance...");
await runManagedFrontendContract({ Frontend: DexFrontend, fixture: dexFixture });
console.log("    ok dex conformance passed");

console.log("  testing JvmFrontend conformance...");
await runManagedFrontendContract({ Frontend: JvmFrontend, fixture: jvmFixture });
console.log("    ok jvm conformance passed");

console.log("  testing CilFrontend conformance...");
await runManagedFrontendContract({ Frontend: CilFrontend, fixture: cilFixture });
console.log("    ok cil conformance passed");

// Negative contract test doubles
console.log("  testing negative doubles...");

// 1. unstable method IDs between enumerations
{
  let count = 0;
  class UnstableMethodFrontend extends WasmFrontend {
    async *enumerateMethods(img) {
      count++;
      yield { id: "method_" + count, moduleId: img.moduleId, name: "test" };
    }
  }
  await assert.rejects(async () => {
    await runManagedFrontendContract({ Frontend: UnstableMethodFrontend, fixture: wasmFixture });
  });
  console.log("    ok negative 1 caught");
}

// 2. missing moduleId on method
{
  class MissingModuleIdFrontend extends WasmFrontend {
    async *enumerateMethods(img) {
      yield { id: "m1", name: "test" };
    }
  }
  await assert.rejects(async () => {
    await runManagedFrontendContract({ Frontend: MissingModuleIdFrontend, fixture: wasmFixture });
  });
  console.log("    ok negative 2 caught");
}

// 3. decodeMethod succeeds without context.image
{
  class PermissiveDecodeFrontend extends WasmFrontend {
    async decodeMethod(method, context = {}) {
      return { methodId: method.id, bundles: [] };
    }
  }
  await assert.rejects(async () => {
    await runManagedFrontendContract({ Frontend: PermissiveDecodeFrontend, fixture: wasmFixture });
  });
  console.log("    ok negative 3 caught");
}

// 4. validation report lacks specValidation axis
{
  class BadValidationFrontend extends WasmFrontend {
    async validateMethod(decoded, context = {}) {
      return { targetId: decoded.methodId, status: "valid", completeness: { structural: "complete" } };
    }
  }
  await assert.rejects(async () => {
    await runManagedFrontendContract({ Frontend: BadValidationFrontend, fixture: wasmFixture });
  });
  console.log("    ok negative 4 caught");
}

// 5. lifted method changes method identity
{
  class MutatingLiftFrontend extends WasmFrontend {
    async liftMethod(decoded, val, context = {}) {
      return { methodId: "different_id" };
    }
  }
  await assert.rejects(async () => {
    await runManagedFrontendContract({ Frontend: MutatingLiftFrontend, fixture: wasmFixture });
  });
  console.log("    ok negative 5 caught");
}

console.log("  ok all managed frontend conformance tests passed!");
