import assert from "node:assert/strict";
import * as facade from "../js/arm64.js";
import * as directOperands from "../js/ui/explain/arm64-operands.js";
import * as directAapcs from "../js/abi/aapcs64/presentation.js";

console.log("Testing ARM64 presentation compatibility...");

// 1. Operand corpus
const OPERAND_CORPUS = [
  "",
  "x0",
  "w8",
  "sp",
  "wsp",
  "xzr",
  "wzr",
  "lr",
  "fp",
  "#0",
  "#9",
  "#10",
  "#-1",
  "#0x20",
  "#-0x20",
  "#1.5",
  "x1, x2, lsl #3",
  "x1, w2, sxtw #2",
  "[x0]",
  "[x0, #0x10]",
  "[x0, #-16]!",
  "[x0], #8",
  "[x0, x1]",
  "[x0, w1, uxtw #2]",
  "{v0.16b, v1.16b}",
  "v2.s[3]",
  "eq",
  "ne",
];

for (const input of OPERAND_CORPUS) {
  const fromFacade = facade.parseOperands(input);
  const fromDirect = directOperands.parseOperands(input);
  assert.deepEqual(fromFacade, fromDirect, `parseOperands mismatch on: "${input}"`);
}
console.log("  ok 1 operand corpus deep equality");

// 2. Immediate and display corpus
const IMM_TESTS = [
  { k: "imm", text: "#0", value: 0n },
  { k: "imm", text: "#9", value: 9n },
  { k: "imm", text: "#10", value: 10n },
  { k: "imm", text: "#-1", value: -1n },
  { k: "imm", text: "#0x20", value: 32n },
  { k: "imm", text: "#-0x20", value: -32n },
  { k: "imm", text: "#1.5", value: null, float: 1.5 },
  { k: "imm", text: "#0xffff", value: 0xffffn },
  { k: "imm", text: "#0x10000", value: 0x10000n },
  { k: "imm", text: "#0x100000000", value: 0x100000000n },
];

for (const imm of IMM_TESTS) {
  assert.equal(facade.immText(imm), directOperands.immText(imm));
  assert.equal(facade.opShort(imm), directOperands.opShort(imm));
}
console.log("  ok 2 immediate/display corpus");

// 3. Condition corpus
const COND_CODES = ["eq", "ne", "cs", "hs", "cc", "lo", "mi", "pl", "vs", "vc", "hi", "ls", "ge", "lt", "gt", "le", "al", "nv"];
for (const cond of COND_CODES) {
  assert.deepEqual(facade.condInfo(cond), directOperands.condInfo(cond), `condInfo mismatch on: "${cond}"`);
}
console.log("  ok 3 condition corpus");

// 4. Register role corpus
for (let num = 0; num < 32; num++) {
  assert.deepEqual(facade.registerRole(num), directAapcs.registerRole(num));
}
assert.deepEqual(facade.registerRole(31, true, false), directAapcs.registerRole(31, true, false));
assert.deepEqual(facade.registerRole(31, false, true), directAapcs.registerRole(31, false, true));

assert.equal(directAapcs.registerRole(31, true, false).id, "sp");
assert.equal(directAapcs.registerRole(31, false, true).id, "zr");
assert.equal(directAapcs.registerRole(0).id, "arg");
assert.equal(directAapcs.registerRole(8).id, "x8");
assert.equal(directAapcs.registerRole(9).id, "temp");
assert.equal(directAapcs.registerRole(16).id, "ip");
assert.equal(directAapcs.registerRole(18).id, "x18");
assert.equal(directAapcs.registerRole(19).id, "saved");
assert.equal(directAapcs.registerRole(29).id, "fp");
assert.equal(directAapcs.registerRole(30).id, "lr");
console.log("  ok 4 register role corpus");

// 5. Public facade smoke coverage
assert.equal(facade.referenceTarget("b", "#0x1000"), 0x1000n);
assert.equal(facade.isBranch("b"), true);
assert.equal(facade.isCall("bl"), true);
assert.equal(facade.isReturn("ret"), true);
assert.equal(typeof facade.categoryOf("add"), "string");
assert.equal(typeof facade.categoryLabel("arith"), "string");
assert.equal(typeof facade.explain("add", "x0, x1, x2"), "object");
assert.equal(typeof facade.brief("add", "x0, x1, x2"), "string");
facade.clearBriefCache();
console.log("  ok 5 public facade smoke");

console.log("All ARM64 presentation compatibility tests PASS!");
