import { buildMinimalJvmClass } from "../jvm/jvm-parser.test.mjs";

export const fixture = Object.freeze({
  id: "jvm",
  createBytes: () => buildMinimalJvmClass(),
  expectedModuleCount: 1,
  expectedMinimumTypeCount: 1,
  expectedMinimumMethodCount: 1,
  selectDecodableMethod: (methods) => methods[0] || null,
});
