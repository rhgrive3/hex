import { buildMinimalCil } from "../cil/cil-parser.test.mjs";

export const fixture = Object.freeze({
  id: "cil",
  createBytes: () => buildMinimalCil(),
  expectedModuleCount: 1,
  expectedMinimumTypeCount: 1,
  expectedMinimumMethodCount: 1,
  selectDecodableMethod: (methods) => methods[0] || null,
});
