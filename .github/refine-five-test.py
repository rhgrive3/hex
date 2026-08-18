from pathlib import Path

p = Path('tests/semantic-v2/issues-828-832-860-867-880.test.mjs')
s = p.read_text()
old = "assert.match(legacy, /storeLoc\\.kind !== otherLoc\\.kind[\\s\\S]*storeLoc\\.kind === MK\\.FIELD \\|\\| otherLoc\\.kind === MK\\.FIELD\\) return true/);"
new = "assert.match(legacy, /storeLoc\\.kind !== otherLoc\\.kind[\\s\\S]*concreteLoc\\.kind === MK\\.GLOBAL\\) return true[\\s\\S]*concreteLoc\\.kind === MK\\.STACK[\\s\\S]*entryDistinct/);"
if s.count(old) != 1:
    raise SystemExit(f'expected one issue 832 source assertion, got {s.count(old)}')
p.write_text(s.replace(old, new, 1))
