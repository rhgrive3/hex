import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverPhaseTests,
  parsePhaseGroup,
  selectPhaseTests,
  runPhaseNodeTests,
} from "./support/phase-node-test-runner.mjs";
import { discoverPhase8Tests } from "./phase8/run.mjs";
import { discoverPhase9Tests } from "./phase9/run.mjs";
import { discoverPhase10Tests } from "./phase10/run.mjs";

console.log("Testing Phase test runner contract...");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hex-phase-test-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 1. recursive discovery
withTempDir((temp) => {
  fs.mkdirSync(path.join(temp, "foundation"), { recursive: true });
  fs.mkdirSync(path.join(temp, "vertical"), { recursive: true });
  fs.writeFileSync(path.join(temp, "foundation", "a.test.mjs"), "");
  fs.writeFileSync(path.join(temp, "vertical", "b.test.mjs"), "");
  fs.writeFileSync(path.join(temp, "c.test.mjs"), "");
  fs.writeFileSync(path.join(temp, "ignore.mjs"), "");
  fs.writeFileSync(path.join(temp, "ignore.js"), "");

  const discovered = discoverPhaseTests(temp);
  assert.equal(discovered.length, 3);
  assert.ok(discovered.every((f) => f.endsWith(".test.mjs")));
  console.log("  ok 1 recursive discovery");
});

// 2. deterministic byte ordering
withTempDir((temp) => {
  fs.writeFileSync(path.join(temp, "z.test.mjs"), "");
  fs.writeFileSync(path.join(temp, "a.test.mjs"), "");
  fs.writeFileSync(path.join(temp, "m.test.mjs"), "");
  const discovered = discoverPhaseTests(temp).map((f) => path.basename(f));
  assert.deepEqual(discovered, ["a.test.mjs", "m.test.mjs", "z.test.mjs"]);
  console.log("  ok 2 deterministic byte ordering");
});

// 3. no-test failure
withTempDir((temp) => {
  assert.throws(() => runPhaseNodeTests({ phase: "testphase", root: temp }), (err) => {
    return err.message === "testphase: no contract tests discovered";
  });
  console.log("  ok 3 no-test failure");
});

// 4. argv contract
{
  assert.equal(parsePhaseGroup([], { phase: "p" }), null);
  assert.equal(parsePhaseGroup(["--group", "foundation"], { phase: "p" }), "foundation");
  assert.equal(parsePhaseGroup(["--group", "foundation/"], { phase: "p" }), "foundation");
  assert.throws(() => parsePhaseGroup(["--group", "foundation", "extra"], { phase: "p" }), TypeError);
  assert.throws(() => parsePhaseGroup(["--group=foundation"], { phase: "p" }), TypeError);
  assert.throws(() => parsePhaseGroup(["--group", "../x"], { phase: "p" }), TypeError);
  assert.throws(() => parsePhaseGroup(["--group", "Upper"], { phase: "p" }), TypeError);
  assert.throws(() => parsePhaseGroup(["--group", "foo\\bar"], { phase: "p" }), TypeError);
  console.log("  ok 4 argv contract");
}

// 5. file group selection
withTempDir((temp) => {
  const files = [
    path.join(temp, "smoke.test.mjs"),
    path.join(temp, "smoke-extra.test.mjs"),
  ];
  const selected = selectPhaseTests(files, { root: temp, group: "smoke" });
  assert.deepEqual(selected, [path.join(temp, "smoke.test.mjs")]);
  console.log("  ok 5 file group selection");
});

// 6. directory group selection
withTempDir((temp) => {
  const files = [
    path.join(temp, "foundation", "a.test.mjs"),
    path.join(temp, "foundation", "sub", "b.test.mjs"),
    path.join(temp, "vertical", "c.test.mjs"),
  ];
  const selected = selectPhaseTests(files, { root: temp, group: "foundation" });
  assert.equal(selected.length, 2);
  console.log("  ok 6 directory group selection");
});

// 7. empty group failure
withTempDir((temp) => {
  fs.writeFileSync(path.join(temp, "a.test.mjs"), "");
  assert.throws(() => runPhaseNodeTests({ phase: "testphase", root: temp, argv: ["--group", "nonexistent"] }), (err) => {
    return err.message === "testphase: group has no discovered tests: nonexistent";
  });
  console.log("  ok 7 empty group failure");
});

// 8. spawn argv lock
withTempDir((temp) => {
  fs.writeFileSync(path.join(temp, "a.test.mjs"), "");
  let spawnCalls = [];
  const fakeSpawn = (execPath, args, options) => {
    spawnCalls.push({ execPath, args, options });
    return { status: 0 };
  };
  runPhaseNodeTests({ phase: "testphase", root: temp, spawn: fakeSpawn });
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].execPath, process.execPath);
  assert.equal(spawnCalls[0].args[0], "--test");
  assert.equal(spawnCalls[0].args[1], "--test-reporter=spec");
  assert.equal(spawnCalls[0].args[2], "--test-concurrency=1");
  assert.equal(spawnCalls[0].args[3], path.join(temp, "a.test.mjs"));
  console.log("  ok 8 spawn argv lock");
});

// 9. spawn options lock
withTempDir((temp) => {
  fs.writeFileSync(path.join(temp, "a.test.mjs"), "");
  let capturedOpts = null;
  const fakeSpawn = (execPath, args, options) => {
    capturedOpts = options;
    return { status: 0 };
  };
  runPhaseNodeTests({ phase: "testphase", root: temp, spawn: fakeSpawn, cwd: "/custom/cwd" });
  assert.equal(capturedOpts.cwd, "/custom/cwd");
  assert.equal(capturedOpts.encoding, "utf8");
  assert.equal(capturedOpts.maxBuffer, 512 * 1024 * 1024);
  console.log("  ok 9 spawn options lock");
});

// 10. child error propagation
withTempDir((temp) => {
  fs.writeFileSync(path.join(temp, "a.test.mjs"), "");
  const sentinel = new Error("sentinel error");
  const fakeSpawn = () => ({ error: sentinel });
  assert.throws(() => runPhaseNodeTests({ phase: "testphase", root: temp, spawn: fakeSpawn }), (err) => err === sentinel);
  console.log("  ok 10 child error propagation");
});

// 11. non-zero status
withTempDir((temp) => {
  fs.writeFileSync(path.join(temp, "a.test.mjs"), "");
  const fakeSpawn = () => ({ status: 7 });
  assert.throws(() => runPhaseNodeTests({ phase: "testphase", root: temp, spawn: fakeSpawn }), (err) => {
    return err.message === "testphase: test runner failed with status 7";
  });
  console.log("  ok 11 non-zero status");
});

// 12. success result
withTempDir((temp) => {
  fs.writeFileSync(path.join(temp, "a.test.mjs"), "");
  const fakeSpawn = () => ({ status: 0 });
  const result = runPhaseNodeTests({ phase: "testphase", root: temp, spawn: fakeSpawn });
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(result, { selected: 1, total: 1, group: null });
  console.log("  ok 12 success result");
});

// 13. wrapper discovery parity
withTempDir((temp) => {
  fs.writeFileSync(path.join(temp, "a.test.mjs"), "");
  assert.deepEqual(discoverPhase8Tests(temp), discoverPhaseTests(temp));
  assert.deepEqual(discoverPhase9Tests(temp), discoverPhaseTests(temp));
  assert.deepEqual(discoverPhase10Tests(temp), discoverPhaseTests(temp));
  console.log("  ok 13 wrapper discovery parity");
});

// 14. wrapper execution parity
{
  const src8 = fs.readFileSync("/workspaces/hex/tests/phase8/run.mjs", "utf8");
  const src9 = fs.readFileSync("/workspaces/hex/tests/phase9/run.mjs", "utf8");
  const src10 = fs.readFileSync("/workspaces/hex/tests/phase10/run.mjs", "utf8");
  assert.ok(src8.includes('phase: "phase8"'));
  assert.ok(src9.includes('phase: "phase9"'));
  assert.ok(src10.includes('phase: "phase10"'));
  console.log("  ok 14 wrapper execution parity");
}

// 15. real current discovery counts
{
  const p8 = discoverPhase8Tests();
  const p9 = discoverPhase9Tests();
  const p10 = discoverPhase10Tests();
  assert.ok(p8.length > 0);
  assert.ok(p9.length > 0);
  assert.ok(p10.length > 0);
  assert.ok(p8.every((f) => f.endsWith(".test.mjs")));
  assert.ok(p9.every((f) => f.endsWith(".test.mjs")));
  assert.ok(p10.every((f) => f.endsWith(".test.mjs")));
  console.log("  ok 15 real current discovery non-empty");
}

// 16. Phase 8 recursive-discovery invariant
{
  const p8 = discoverPhase8Tests();
  const nested = p8.some((f) => path.dirname(f) !== path.resolve("/workspaces/hex/tests/phase8"));
  assert.ok(nested, "Phase 8 must discover tests in subdirectories");
  console.log("  ok 16 Phase 8 recursive-discovery invariant");
}

console.log("All Phase test runner contract tests PASS!");
