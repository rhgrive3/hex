import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadManifest } from '../../../tools/validation/phase5-ownership.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RETIRED_PHASE2_WORKFLOW = path.join(ROOT, '.github/workflows/phase2-effects-integration.yml');
const GENERATED_SYNC = fs.readFileSync(path.join(ROOT, '.github/workflows/generated-sync.yml'), 'utf8');
const MANIFEST = loadManifest();

test('generated userscript ownership survives retirement of Phase 2/5 campaign wrappers', () => {
  assert.deepEqual(MANIFEST.generatedWriteOwners, ['p5-0', 'p5-i']);
  assert.equal(fs.existsSync(RETIRED_PHASE2_WORKFLOW), false);
  assert.match(GENERATED_SYNC, /npm run userscript:build/);
  assert.match(GENERATED_SYNC, /git diff --exit-code --/);
  assert.match(GENERATED_SYNC, /userscript\/hex\.user\.template\.js/);
  assert.match(GENERATED_SYNC, /userscript\/release-version\.json/);
  assert.doesNotMatch(GENERATED_SYNC, /deployment-identity\.generated\.js/,
    'Cloudflare-owned deployment identity must not be treated as local userscript output');
});
