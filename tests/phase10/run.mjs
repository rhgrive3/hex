import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPhaseTests, runPhaseNodeTests } from "../support/phase-node-test-runner.mjs";

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

export function discoverPhase10Tests(root = DIRECTORY) {
  return discoverPhaseTests(root);
}

export function runPhase10Tests(argv = process.argv.slice(2), { root = DIRECTORY } = {}) {
  return runPhaseNodeTests({
    phase: "phase10",
    root,
    argv,
    cwd: path.resolve(root, "../.."),
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runPhase10Tests();
