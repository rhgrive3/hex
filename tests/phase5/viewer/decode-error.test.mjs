import test from 'node:test';
import assert from 'node:assert/strict';
import { VariableInstructionIndex } from '../../../js/viewer/variable-instruction-index.js';

function ins(address, length=1) {
  return { address:BigInt(address), length, rawBytes:Uint8Array.from({ length }, () => 0x90), mnemonic:'nop', opStr:'' };
}

test('adjacent undecodable page becomes one explicit non-instruction marker and makes no fake progress', async () => {
  const base = 0x7000n;
  const calls = [];
  const index = new VariableInstructionIndex({
    pageBytes:32,
    maxPrefetchPages:0,
    disassembleAt:async (address, { length }) => {
      calls.push({ address:BigInt(address), length });
      if (BigInt(address) === base) {
        return { supported:true, instructions:Array.from({ length:32 }, (_, i) => ins(base + BigInt(i))), bytesRead:length };
      }
      return { supported:true, instructions:[], bytesRead:length };
    },
  });
  index.configureRegion({ id:'decode-gap', vmAddr:base, size:256n });
  const first = await index.ensurePage(base);
  assert.equal(first.nextAddress, base + 32n);
  const failed = await index.ensurePage(first.nextAddress, { protect:false });
  assert.equal(failed.status, 'undecodable');
  assert.equal(failed.nextAddress, failed.start, 'decode failure must not invent byte progress');

  const rows = index.localRows(base);
  const marker = rows.at(-1);
  assert.equal(marker.kind, 'decode-error');
  assert.equal(marker.address, base + 32n);
  assert.equal(marker.length, 0, 'error marker is not a fabricated x86 instruction');
  assert.equal(marker.bytes.length, 0);
  assert.equal(marker.mnemonic, '???');
  assert.equal(marker.status, 'undecodable');
  assert.equal(index.knownEntry(marker.address), null, 'error marker must never become a proven instruction boundary');
  assert.equal(index.metrics().retainedInstructions, 32, 'error marker is not retained as instruction metadata');

  const before = calls.length;
  const rowsAgain = index.localRows(base);
  assert.equal(rowsAgain.at(-1).kind, 'decode-error');
  assert.equal(calls.length, before, 'rendering the marker must not recursively retry or loop');
});
