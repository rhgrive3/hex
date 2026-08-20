import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { architectureBoundaryViolations } from '../../../tools/validation/phase8/metrics.mjs';

/**
 * Phase 8's generic middle end must not name architecture registers, flags,
 * decoders or ABIs. A pass that reaches for one works on the target it was
 * written against and quietly stops working on the others, which is exactly the
 * failure the architecture/ABI separation invariant exists to prevent.
 *
 * The scanner is checked in both directions here: a gate that has stopped
 * rejecting anything is worse than no gate, because it reports success.
 */

test('the shipped Phase 8 sources hold the boundary', () => {
  assert.deepEqual(architectureBoundaryViolations(), []);
});

function scanSnippet(source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-boundary-'));
  try {
    fs.writeFileSync(path.join(directory, 'probe.js'), source);
    return architectureBoundaryViolations(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('the scanner still rejects architecture identifiers in code', () => {
  for (const source of [
    'export const register = "x0";\n',
    'export function flags() { return nzcv; }\n',
    'const target = "rax";\n',
    'const abi = AAPCS64_ABI;\n',
  ]) {
    assert.equal(scanSnippet(source).length, 1, `the scanner accepted architecture code: ${source.trim()}`);
  }
});

test('prose explaining the boundary is not a violation of it', () => {
  // The sentence "generic code must not know what nzcv means" is the opposite of
  // generic code knowing what nzcv means. Block comments span lines, so the
  // scanner has to track that state instead of stripping each line alone.
  assert.deepEqual(scanSnippet([
    '/**',
    ' * This pass is generic: it never needs to know what `nzcv` or `eflags` mean,',
    ' * and it names no register such as x0 or rax.',
    ' */',
    'export const value = 1;',
    '',
  ].join('\n')), []);
  assert.deepEqual(scanSnippet('export const value = 1; // not about w0 at all\n'), []);
});

test('code after a block comment on the same line is still scanned', () => {
  // The narrow risk of comment tracking is that it swallows real code.
  assert.equal(scanSnippet('/* about nzcv */ export const register = "x0";\n').length, 1);
});
