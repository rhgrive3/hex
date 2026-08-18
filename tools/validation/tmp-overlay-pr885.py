from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one patch anchor, got {count}")
    p.write_text(text.replace(old, new, 1))


replace_once(
    "js/verify.js",
    """      if (!/^(cmp|cmn|subs|adds|ccmp|fcmp|tst)$/.test(mn)) {""",
    """      // CCMP/CCMN only compare when their predicate holds; otherwise they write
      // the instruction's fallback NZCV. Until that path condition is proven,
      // treating either instruction as an unconditional field guard is unsound.
      if (/^(?:ccmp|ccmn)$/.test(mn)) continue;
      if (!/^(cmp|cmn|subs|adds|fcmp|tst)$/.test(mn)) {""",
)

Path("tests/issue-843-ccmp-guard.mjs").write_text("""import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { fieldUse, verifyGuard, verifyFunctionHandlesField } from '../js/verify.js';

const BASE = 0x100000000n;

function build(lines) {
  return buildSemanticModel(lines.map((line, row) => {
    const text = String(line).trim();
    const split = text.indexOf(' ');
    return {
      row,
      address: BASE + BigInt(row * 4),
      mn: split < 0 ? text : text.slice(0, split),
      ops: split < 0 ? '' : text.slice(split + 1),
    };
  }), { startRow: 0, endRow: lines.length - 1 });
}

{
  const model = build([
    'ldr w8, [x0, #0x20]',
    'cmp w8, #100',
    'b.ne #0x100000010',
    'ret',
    'ret',
  ]);
  const use = fieldUse(model, 0x20n);
  assert.equal(use.compares.length, 1);
  assert.equal(use.compares[0].mnemonic, 'cmp');
  assert.equal(use.compares[0].value, 100n);
  assert.equal(verifyGuard(model, 0x20n).guards.length, 1);
  assert.equal(verifyFunctionHandlesField(model, 0x20n).guard, true);
}

{
  const model = build([
    'ldr w8, [x0, #0x20]',
    'cmp w0, #0',
    'ccmp w8, #100, #0, eq',
    'b.ne #0x100000014',
    'ret',
    'ret',
  ]);
  assert.equal(model.instructions[2].mnemonic, 'ccmp');
  assert.ok(model.instructions[2].reads.includes('x8'), 'regression must exercise a decoded field operand');
  assert.equal(fieldUse(model, 0x20n).compares.length, 0);
  assert.equal(verifyGuard(model, 0x20n).guards.length, 0);
  assert.equal(verifyFunctionHandlesField(model, 0x20n).guard, false);
}

{
  const model = build([
    'ldr w8, [x0, #0x20]',
    'cmp w0, #0',
    'ccmp w8, #100, #0, eq',
    'ccmp w8, #200, #0, ne',
    'b.eq #0x100000018',
    'ret',
    'ret',
  ]);
  assert.equal(fieldUse(model, 0x20n).compares.length, 0);
}

console.log('issue 843 CCMP guard regression: ok');
""")

suite = Path("tests/issues-550-559.mjs")
text = suite.read_text()
line = "await import('./issue-843-ccmp-guard.mjs');"
if line not in text:
    anchor = "console.log('issues 550-559 regressions: ok');"
    if text.count(anchor) != 1:
        raise SystemExit(f"tests/issues-550-559.mjs: expected one log anchor, got {text.count(anchor)}")
    text = text.replace(anchor, line + "\n" + anchor, 1)
    suite.write_text(text)
