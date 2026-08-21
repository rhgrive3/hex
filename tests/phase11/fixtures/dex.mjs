import { buildMinimalDex } from "../dex/dex-parser.test.mjs";

export const fixture = Object.freeze({
  id: "dex",
  createBytes: () => buildMinimalDex(),
  expectedModuleCount: 1,
  expectedMinimumTypeCount: 1,
  expectedMinimumMethodCount: 1,
  selectDecodableMethod: (methods) => methods[0] || null,
});
