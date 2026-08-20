import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { withFileRollback } from '../../../tools/validation/phase8/finalize.mjs';

test('P8-I finalizer restores every owned evidence file when verification fails', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-p8i-finalize-'));
  const existing = path.join(directory, 'existing.json');
  const created = path.join(directory, 'created.md');
  fs.writeFileSync(existing, 'before\n');
  try {
    await assert.rejects(withFileRollback([existing, created], async () => {
      fs.writeFileSync(existing, 'temporary accepted ledger\n');
      fs.writeFileSync(created, 'temporary READY evidence\n');
      throw new Error('BLOCKING');
    }), /BLOCKING/);
    assert.equal(fs.readFileSync(existing, 'utf8'), 'before\n');
    assert.equal(fs.existsSync(created), false);
  } finally {
    fs.rmSync(directory, { recursive:true, force:true });
  }
});

test('P8-I finalizer keeps owned files only after its transaction succeeds', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-p8i-finalize-'));
  const evidence = path.join(directory, 'evidence.json');
  try {
    const value = await withFileRollback([evidence], async () => {
      fs.writeFileSync(evidence, 'READY\n');
      return 'READY';
    });
    assert.equal(value, 'READY');
    assert.equal(fs.readFileSync(evidence, 'utf8'), 'READY\n');
  } finally {
    fs.rmSync(directory, { recursive:true, force:true });
  }
});
