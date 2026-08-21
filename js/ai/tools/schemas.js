export function cursorProperty() { return { type: "string", minLength: 8, maxLength: 4096 }; }
export function searchSchema() { return { type: "object", required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 1000 }, limit: limitProperty(40, 200), cursor: cursorProperty() }, additionalProperties: false }; }
export function emptySchema() { return { type: "object", properties: {}, additionalProperties: false }; }
export function addressProperty() { return { type: "string", pattern: "^0x[0-9a-fA-F]+$" }; }
export function limitProperty(fallback, max) { return { type: "integer", minimum: 1, maximum: max, default: fallback }; }
export function addressSchema(key = "address") { return { type: "object", required: [key], properties: { [key]: addressProperty() }, additionalProperties: false }; }
export function addressLimitSchema(key = "address", fallback = 100, pageable = true) {
  const properties = { [key]: addressProperty(), limit: limitProperty(fallback, 1000) };
  if (pageable) properties.cursor = cursorProperty();
  return { type: "object", required: [key], properties, additionalProperties: false };
}
export function semanticSchema() { return { type: "object", required: ["functionAddress"], properties: { functionAddress: addressProperty(), kinds: { type: "array", maxItems: 20, items: { type: "string" } }, limit: limitProperty(300, 1000), cursor: cursorProperty() }, additionalProperties: false }; }
export function fieldValueSchema() { return { anyOf: [{ type: "string", maxLength: 200 }, { type: "integer" }, { type: "object" }] }; }
export function fieldSchema() { return { type: "object", required: ["functionAddress", "field"], properties: { functionAddress: addressProperty(), field: fieldValueSchema(), limit: limitProperty(100, 1000), cursor: cursorProperty() }, additionalProperties: false }; }
export function sliceSchema() { return { type: "object", required: ["functionAddress", "seed"], properties: { functionAddress: addressProperty(), seed: {}, limit: limitProperty(400, 2000) }, additionalProperties: false }; }
export function traceSchema() { const schema = sliceSchema(); schema.properties.direction = { enum: ["backward", "forward"] }; return schema; }
export function thresholdSchema() { return { type: "object", required: ["functionAddress"], properties: { functionAddress: addressProperty(), value: { anyOf: [{ type: "string" }, { type: "integer" }] }, limit: limitProperty(300, 1000), cursor: cursorProperty() }, additionalProperties: false }; }
export function verifyFieldSchema() { return { type: "object", required: ["functionAddress", "field"], properties: { functionAddress: addressProperty(), field: fieldValueSchema(), limit: limitProperty(8, 32), pathLimit: limitProperty(8, 32) }, additionalProperties: false }; }
export function lookupSchema() { return { type: "object", properties: { query: { type: "string", maxLength: 1000 }, name: { type: "string", maxLength: 1000 }, address: addressProperty(), limit: limitProperty(20, 100) }, additionalProperties: false }; }
export function compareSchema() { return { type: "object", required: ["leftAddress", "rightAddress"], properties: { leftAddress: addressProperty(), rightAddress: addressProperty() }, additionalProperties: false }; }
export function runtimeObservationSchema() { return { type: "object", properties: { functionAddress: addressProperty(), limit: limitProperty(100, 500), cursor: cursorProperty() }, additionalProperties: false }; }
export function runtimeVerifySchema() { return { type: "object", required: ["hypothesis"], properties: { hypothesis: { type: "object" }, options: { type: "object" } }, additionalProperties: false }; }
export function regionSchema() { return {
  type: "object", required: ["functionAddress", "view"], additionalProperties: false,
  properties: {
    functionAddress: addressProperty(), view: { type: "string", enum: ["assembly", "semantic-ir", "pseudocode", "cfg"] },
    start: { type: "integer", minimum: 0, maximum: 10000000 }, count: limitProperty(160, 500), cursor: cursorProperty(),
    aroundInstructionId: { type: "integer", minimum: 0, maximum: 100000000 }, radius: { type: "integer", minimum: 1, maximum: 200 },
  },
}; }
export function constantSchema() { return { type: "object", required: ["value"], additionalProperties: false, properties: { value: { anyOf: [{ type: "string" }, { type: "integer" }] }, functions: { type: "array", maxItems: 128, items: addressProperty() }, limit: limitProperty(100, 1000) } }; }
export function pathSchema() { return { type: "object", required: ["from", "to"], additionalProperties: false, properties: { from: addressProperty(), to: addressProperty(), maxDepth: limitProperty(6, 12), maxPaths: limitProperty(8, 32), maxVisited: limitProperty(10000, 20000) } }; }
export function explainEvidenceSchema() { return { type: "object", required: ["evidenceIds"], additionalProperties: false, properties: { evidenceIds: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 200 } }, functions: { type: "array", maxItems: 128, items: addressProperty() }, limit: limitProperty(200, 1000) } }; }
export function symbolicSchema() { return { type: "object", required: ["functionAddress"], additionalProperties: false, properties: { functionAddress: addressProperty(), maxPaths: limitProperty(16, 32), maxSteps: limitProperty(2000, 5000), maxBranches: limitProperty(32, 64), maxBlockVisits: limitProperty(3, 8), timeoutMs: { type: "integer", minimum: 10, maximum: 1000 } } }; }
export function observationDetailSchema() { return { type: "object", required: ["detailRef"], additionalProperties: false, properties: { detailRef: { type: "string", minLength: 8, maxLength: 256 }, path: { type: "string", maxLength: 512 }, cursor: cursorProperty(), limit: limitProperty(100, 500) } }; }
export function evidenceDetailSchema() { return { type: "object", required: ["evidenceId"], additionalProperties: false, properties: { evidenceId: { type: "string", minLength: 3, maxLength: 256 }, cursor: cursorProperty(), limit: limitProperty(100, 500) } }; }
