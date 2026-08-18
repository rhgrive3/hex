from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
HEAD = "ed2822bb6e4421ec312c5ae9159d40164361e81f"
MAIN = "3e48eff360ffdc6f9079689bf2f4cff8b3647dc5"


def git_show(commit, path):
    data = subprocess.check_output(["git", "show", f"{commit}:{path}"], cwd=ROOT)
    (ROOT / path).write_bytes(data)


# #883 is the canonical implementation for the same completion/resume problem
# also attempted by #879: pool-owned terminal events, existing coordinator queue,
# lease validation, and retained result independence.
for path in [
    "js/userscript/dev/frame-mesh/iframe-worker-pool.js",
    "js/userscript/dev/parent-worker-runtime.js",
    "js/userscript/dev/single-tab/single-conversation-worker-coordinator.js",
    "tests/dev-agent/iframe-worker-pool-completion-events.mjs",
]:
    git_show(HEAD, path)

# Neutralize the older #879 test wiring copied by the first consolidation stage.
# #883 supersedes that implementation rather than stacking two event bridges.
git_show(MAIN, "tests/userscript-runtime-host-location.mjs")
(ROOT / "tests/dev-agent/pool-completion-event-resume.mjs").unlink(missing_ok=True)

p = ROOT / "package.json"
s = p.read_text()
old = '"dev-agent:test": "node tests/dev-agent/round1-foundation.mjs && node tests/dev-agent/round2-single-worker.mjs && node tests/dev-agent/round2-single-tab-supervisor.mjs && node tests/dev-agent/supervisor-conversation-continuity.mjs"'
new = '"dev-agent:test": "node tests/dev-agent/round1-foundation.mjs && node tests/dev-agent/round2-single-worker.mjs && node tests/dev-agent/round2-single-tab-supervisor.mjs && node tests/dev-agent/supervisor-conversation-continuity.mjs && node tests/dev-agent/iframe-worker-pool-completion-events.mjs"'
if s.count(old) != 1:
    raise SystemExit(f"#883 package dev-agent:test anchor mismatch: {s.count(old)}")
p.write_text(s.replace(old, new, 1))

print("PR #883 overlay materialized; #879 bridge neutralized")
