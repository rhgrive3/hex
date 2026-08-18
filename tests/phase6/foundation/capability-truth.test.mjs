import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CAPABILITY_STATUS, architectureMaturity, currentSupportMatrix } from '../../../js/platform/capability-maturity.js';
import { architecturePluginV2 } from '../../../js/targets/architecture/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROFILE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/validation/phase6/profile.json'), 'utf8'));

/**
 * Release-truth regressions.
 *
 * The Phase 5 prerequisite audit found capability declarations that had gone
 * stale: the merged product proved an x86-64 semantic vertical over its full
 * mandatory corpus while the machine-readable profile still said "decode only".
 * Nothing failed, because nothing checked the declaration against the evidence.
 *
 * These tests are that check. The first one pins the exact stale shape so it
 * cannot silently return; the rest bound the claims from above so a future
 * change cannot inflate capability beyond what the corpus proves.
 */

const STALE_X86_DECLARATION = Object.freeze({
  implementedLevel: 'A1',
  fullySatisfiedLevel: 'A1',
  status: CAPABILITY_STATUS.SUPPORTED,
  lowLevelEffects: 'unsupported',
  cfgSemanticIR: 'unsupported',
  ssaMemoryDataflow: 'unsupported',
  decompiler: 'unsupported',
});

test('the stale Phase 5 x86-64 capability declaration cannot come back', () => {
  const x86 = architectureMaturity('x86_64');
  const stale = x86.implementedLevel === STALE_X86_DECLARATION.implementedLevel
    && x86.status === STALE_X86_DECLARATION.status
    && x86.features.lowLevelEffects === STALE_X86_DECLARATION.lowLevelEffects
    && x86.features.cfgSemanticIR === STALE_X86_DECLARATION.cfgSemanticIR
    && x86.features.ssaMemoryDataflow === STALE_X86_DECLARATION.ssaMemoryDataflow
    && x86.features.decompiler === STALE_X86_DECLARATION.decompiler;
  assert.equal(stale, false,
    'x86-64 is declared decode-only again, but tests/phase5/verification/compiler-corpus-pipeline proves the full 144-tuple semantic vertical');

  // What the Phase 5 evidence actually supports, no more.
  assert.equal(x86.implementedLevel, 'A6');
  assert.equal(x86.status, CAPABILITY_STATUS.PARTIAL);
  assert.equal(x86.features.decompiler, 'supported');
});

test('no architecture claims a cumulative level that skips an incomplete prerequisite', () => {
  const order = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'];
  const featureLevel = {
    detect: 'A0', decode: 'A1', lowLevelEffects: 'A2', cfgSemanticIR: 'A3',
    ssaMemoryDataflow: 'A4', typesInterprocedural: 'A5', decompiler: 'A6', runtimeDebugPatchValidation: 'A7',
  };
  for (const entry of currentSupportMatrix().architectures) {
    if (entry.level == null) continue;
    for (const [feature, level] of Object.entries(featureLevel)) {
      if (order.indexOf(level) > order.indexOf(entry.level)) continue;
      assert.equal(entry.features[feature], 'supported',
        `${entry.id} claims cumulative ${entry.level} but ${feature} (${level}) is ${entry.features[feature]}`);
    }
  }
});

test('riscv64 capability matches exactly what the frozen Phase 6 profile claims', () => {
  const riscv = architectureMaturity('riscv64');
  assert.equal(riscv.implementedLevel, PROFILE.capabilityClaim.implementedLevel);
  assert.equal(riscv.level, PROFILE.capabilityClaim.fullySatisfiedLevel);
  assert.equal(riscv.status, CAPABILITY_STATUS.PARTIAL);
  // A2 must stay partial: exactness is proven for RV64IMC, not for every extension.
  assert.equal(riscv.features.lowLevelEffects, 'partial');
  assert.ok(riscv.limitations.includes('riscv64-atomic-float-vector-extensions-unsupported'));
  assert.ok(riscv.limitations.includes('riscv64-exact-effects-limited-to-rv64imc-profile'));
  // A7 is not claimed by Phase 6 at all.
  assert.equal(riscv.features.runtimeDebugPatchValidation, 'unsupported');
});

test('capability is not inferred from the mere existence of a plugin', () => {
  const plugin = architecturePluginV2('riscv64');
  assert.equal(plugin.id, 'riscv64');
  // The plugin exists for riscv32 nowhere, and an unregistered id must not
  // inherit riscv64's capability by resembling it.
  assert.notEqual(architecturePluginV2('riscv32').id, 'riscv64');
  assert.equal(architectureMaturity('riscv32').status, CAPABILITY_STATUS.UNSUPPORTED);
  assert.equal(architectureMaturity('riscv').status, CAPABILITY_STATUS.UNSUPPORTED);
});

test('losing the decoder at runtime downgrades RISC-V rather than keeping a stale claim', () => {
  const withoutDecoder = architectureMaturity('riscv64', { decoderAvailable: false });
  assert.equal(withoutDecoder.features.decode, 'unavailable');
  assert.equal(withoutDecoder.features.decompiler, 'unavailable');
  assert.ok(withoutDecoder.limitations.includes('decoder-unavailable'));
});

test('the human support matrix is not the source of truth, and does not contradict it', () => {
  const document = fs.readFileSync(path.join(ROOT, 'docs/SUPPORT_MATRIX.md'), 'utf8');
  assert.match(document, /machine-readable capability truth/i,
    'the document must keep saying it is a projection of the machine-readable profile');
  for (const entry of currentSupportMatrix().architectures) {
    assert.ok(document.includes(`\`${entry.id}\``), `SUPPORT_MATRIX.md must list ${entry.id}`);
  }
  assert.doesNotMatch(document, /x86_64` \| Supported \| Supported \| Unsupported/,
    'the stale decode-only x86-64 row must not reappear');
});
