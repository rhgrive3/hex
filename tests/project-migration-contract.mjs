import assert from "node:assert/strict";
import {
  HEX_PROJECT_VERSION,
  HEX_PROJECT_MIME,
  MAX_PROJECT_BYTES,
  ProjectFormatError,
  validateHexProject,
  normalizeHexProjectV1,
  serializeHexProject,
  parseHexProject,
  createHexProject,
  migrateHexProject,
  ProjectMigrationError,
  PROJECT_MIGRATIONS,
} from "../js/project/index.js";

console.log("Testing HexProject normalization and migration contract...");

function cloneWithBigInt(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneWithBigInt);
  const out = {};
  for (const k of Object.keys(value)) {
    out[k] = cloneWithBigInt(value[k]);
  }
  return out;
}

// Case 1 — normalize is pure
{
  const input = {
    format: "hexproj",
    version: 1,
    binary: { hash: "abc", metadata: null, embedded: false },
    user: { names: [{ address: 0x1000n, name: "main" }] },
  };
  const snapshot = cloneWithBigInt(input);
  const normalized = validateHexProject(input);
  assert.deepEqual(input, snapshot);
  console.log("  ok Case 1 normalize is pure");
}

// Case 2 — returned containers are independent
{
  const names = [{ address: 0x1000n, name: "main" }];
  const user = { names };
  const binary = { hash: "abc", metadata: null, embedded: false };
  const input = { format: "hexproj", version: 1, binary, user };
  const normalized = validateHexProject(input);

  assert.notStrictEqual(normalized, input);
  assert.notStrictEqual(normalized.binary, binary);
  assert.notStrictEqual(normalized.user, user);
  assert.notStrictEqual(normalized.user.names, names);
  console.log("  ok Case 2 returned containers independent");
}

// Case 3 — serialize is pure
{
  const input = {
    format: "hexproj",
    version: 1,
    binary: { hash: "abc", metadata: null, embedded: false },
  };
  const snapshot = cloneWithBigInt(input);
  const text = serializeHexProject(input);
  assert.ok(typeof text === "string" && text.length > 0);
  assert.deepEqual(input, snapshot);
  console.log("  ok Case 3 serialize is pure");
}

// Case 4 — v1 parse unchanged
{
  const original = createHexProject({
    binaryHash: "sha256_fixture",
    userNames: [{ address: 0x1000n, name: "entry" }],
  });
  const serialized = serializeHexProject(original);
  const parsed = parseHexProject(serialized);
  assert.equal(parsed.format, "hexproj");
  assert.equal(parsed.version, 1);
  assert.equal(parsed.binary.hash, "sha256_fixture");
  assert.deepEqual(parsed.user.names, [{ address: 0x1000n, name: "entry" }]);
  console.log("  ok Case 4 v1 parse round-trip");
}

// Case 5 — future version remains rejected
{
  const future = {
    format: "hexproj",
    version: HEX_PROJECT_VERSION + 1,
    binary: { hash: "abc", metadata: null, embedded: false },
  };
  const text = JSON.stringify(future);
  assert.throws(() => parseHexProject(text), (err) => {
    return err instanceof ProjectFormatError && err.code === "HEX_PROJECT_FUTURE_VERSION";
  });
  console.log("  ok Case 5 future version rejected with HEX_PROJECT_FUTURE_VERSION");
}

// Case 6 — invalid version remains validator-owned
{
  assert.throws(() => parseHexProject(JSON.stringify({ format: "hexproj", version: 0, binary: {} })), (err) => {
    return err instanceof ProjectFormatError && err.code !== "HEX_PROJECT_MIGRATION_MISSING";
  });
  assert.throws(() => parseHexProject(JSON.stringify({ format: "hexproj", version: "1", binary: {} })), (err) => {
    return err instanceof ProjectFormatError && err.code !== "HEX_PROJECT_MIGRATION_MISSING";
  });
  assert.throws(() => parseHexProject(JSON.stringify({ format: "hexproj", binary: {} })), (err) => {
    return err instanceof ProjectFormatError && err.code !== "HEX_PROJECT_MIGRATION_MISSING";
  });
  console.log("  ok Case 6 invalid version validator-owned");
}

// Case 7 — injected sequential migration
{
  const order = [];
  const raw = { format: "hexproj", version: 1, originalData: "kept" };
  const migrations = {
    1: (p) => { order.push(1); return { ...p, version: 2, a: "v2" }; },
    2: (p) => { order.push(2); return { ...p, version: 3, b: "v3" }; },
  };
  const migrated = migrateHexProject(raw, { currentVersion: 3, migrations });
  assert.deepEqual(order, [1, 2]);
  assert.equal(raw.version, 1);
  assert.equal(migrated.version, 3);
  assert.equal(migrated.a, "v2");
  assert.equal(migrated.b, "v3");
  assert.equal(migrated.originalData, "kept");
  console.log("  ok Case 7 injected sequential migration");
}

// Case 8 — missing migration fails closed
{
  const raw = { format: "hexproj", version: 1 };
  const migrations = {
    1: (p) => ({ ...p, version: 2 }),
  };
  assert.throws(() => migrateHexProject(raw, { currentVersion: 3, migrations }), (err) => {
    return err instanceof ProjectMigrationError && err.code === "HEX_PROJECT_MIGRATION_MISSING" && err.fromVersion === 2 && err.toVersion === 3;
  });
  console.log("  ok Case 8 missing migration fails closed");
}

// Case 9 — migration cannot skip versions
{
  const raw = { format: "hexproj", version: 1 };
  const migrations = {
    1: (p) => ({ ...p, version: 3 }),
  };
  assert.throws(() => migrateHexProject(raw, { currentVersion: 3, migrations }), (err) => {
    return err instanceof ProjectMigrationError && err.code === "HEX_PROJECT_MIGRATION_INVALID";
  });
  console.log("  ok Case 9 migration cannot skip versions");
}

// Case 10 — migration cannot return primitive/array
{
  const raw = { format: "hexproj", version: 1 };
  assert.throws(() => migrateHexProject(raw, { currentVersion: 2, migrations: { 1: () => "invalid" } }), (err) => {
    return err instanceof ProjectMigrationError && err.code === "HEX_PROJECT_MIGRATION_INVALID";
  });
  assert.throws(() => migrateHexProject(raw, { currentVersion: 2, migrations: { 1: () => [] } }), (err) => {
    return err instanceof ProjectMigrationError && err.code === "HEX_PROJECT_MIGRATION_INVALID";
  });
  console.log("  ok Case 10 migration cannot return primitive/array");
}

// Case 11 — migration functions are not allowed to rely on mutation
{
  const raw = Object.freeze({ format: "hexproj", version: 1, data: Object.freeze({ x: 1 }) });
  const migrations = {
    1: (p) => Object.freeze({ ...p, version: 2, data: Object.freeze({ ...p.data, y: 2 }) }),
  };
  const migrated = migrateHexProject(raw, { currentVersion: 2, migrations });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.data.y, 2);
  console.log("  ok Case 11 frozen migration objects");
}

// Case 12 — 16 MiB safety limit unchanged
{
  const huge = "x".repeat(17 * 1024 * 1024);
  assert.throws(() => parseHexProject(huge), (err) => {
    return err instanceof ProjectFormatError && err.code === "HEX_PROJECT_TOO_LARGE";
  });
  console.log("  ok Case 12 16 MiB limit unchanged");
}

// Case 13 — malformed BigInt wrapper behavior unchanged
{
  const badBigInt = JSON.stringify({
    format: "hexproj",
    version: 1,
    binary: { hash: "abc", metadata: null, embedded: false },
    val: { $hexBigInt: "not-hex!!" },
  });
  assert.throws(() => parseHexProject(badBigInt), (err) => {
    return err instanceof ProjectFormatError && err.message.includes("invalid bigint encoding");
  });
  console.log("  ok Case 13 malformed BigInt wrapper behavior unchanged");
}

// Case 14 — deterministic normalize
{
  const input1 = {
    format: "hexproj",
    version: 1,
    binary: { hash: "h1", metadata: null, embedded: false },
  };
  const input2 = {
    format: "hexproj",
    version: 1,
    binary: { hash: "h1", metadata: null, embedded: false },
  };
  const n1 = normalizeHexProjectV1(input1);
  const n2 = normalizeHexProjectV1(input2);
  assert.deepEqual(n1, n2);
  console.log("  ok Case 14 deterministic normalize");
}

console.log("All HexProject contract tests PASS!");
