import { DebugAdapter } from "../../../js/debug/adapter.js";
import { DebugAdapterRuntimeProvider } from "../../../js/runtime/provider.js";
import { DebuggerProvider } from "../../../js/runtime/debugger-provider.js";
import { InstrumentationProvider } from "../../../js/runtime/instrumentation-provider.js";
import { TraceProvider } from "../../../js/runtime/trace-provider.js";
import { EmulatorProvider } from "../../../js/runtime/emulator-provider.js";
import { defineRuntimeProviderConformance } from "../helpers/runtime-provider-conformance.mjs";

class MockDebugAdapter extends DebugAdapter {
  constructor() {
    super({ id: "mock-dbg", kind: "lldb", capabilities: { modules: true, readRegisters: true } });
  }
  async connect() {}
  async disconnect() {}
  async getModules() { return []; }
}

defineRuntimeProviderConformance("DebugAdapterRuntimeProvider", {
  createProvider: async () => new DebugAdapterRuntimeProvider(new MockDebugAdapter()),
});

defineRuntimeProviderConformance("DebuggerProvider", {
  createProvider: async () => new DebuggerProvider(new MockDebugAdapter()),
});

defineRuntimeProviderConformance("InstrumentationProvider", {
  createProvider: async () => new InstrumentationProvider({
    async connect() {},
    async disconnect() {},
    async getModules() { return []; },
  }),
});

defineRuntimeProviderConformance("TraceProvider", {
  createProvider: async () => new TraceProvider({
    recordingId: "trace:test",
    sourceProvider: "test-tracer",
    binaryId: "bin_test_conf_TraceProvider",
  }),
  requiresTarget: false,
});

defineRuntimeProviderConformance("EmulatorProvider", {
  createProvider: async () => new EmulatorProvider({
    id: "emu-test",
    version: "1",
    deterministic: true,
    async execute() { return {}; },
  }),
});
