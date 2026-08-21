import { MemoryArtifactBackend } from "../../../js/core/artifacts/backends.js";
import { runArtifactBackendContract } from "./backend-contract.js";

await runArtifactBackendContract({
  name: "memory",
  createBackend: async () => new MemoryArtifactBackend(),
});

console.log("phase4 artifact backend contract memory: PASS");
