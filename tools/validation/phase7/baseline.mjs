import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCorpusManifest } from './corpus-manifest.mjs';
import { collectPhase7Metrics } from './metrics.mjs';

/**
 * Captures the Phase 7 baseline metric ledger.
 *
 * The point of running this before precision work lands is that the comparison
 * numbers exist before anyone knows whether they will be flattering. A baseline
 * captured after the candidate is visible is not a baseline (FM-16).
 *
 * The ledger is bound to the corpus manifest digest. If the manifest changes,
 * the old ledger is a different series and must be regenerated rather than
 * compared across.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export async function captureBaseline({ out = path.join(ROOT, 'reports/phase7') } = {}) {
  const manifest = buildCorpusManifest();
  const metrics = await collectPhase7Metrics({ manifestLanes: manifest.architectureLanes.mandatory });
  const ledger = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    manifestDigest: manifest.manifestDigest,
    corpusId: manifest.corpusId,
    corpusVersion: manifest.corpusVersion,
    scoring: manifest.scoring,
    truthGenerator: manifest.truthGenerator,
    architectureLanes: manifest.architectureLanes,
    alias: metrics.alias.baseline,
    memoryLinks: metrics.memoryLinks.baseline,
    performance: metrics.performance,
  };
  fs.mkdirSync(out, { recursive: true });
  const target = path.join(out, 'baseline-metrics.json');
  const temporary = path.join(out, `.baseline-metrics.json.${process.pid}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`);
  fs.renameSync(temporary, target);
  return { target, ledger };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  captureBaseline().then(({ target, ledger }) => {
    console.log(`phase7 baseline written: ${path.relative(ROOT, target)}`);
    console.log(`manifest digest: ${ledger.manifestDigest}`);
    console.log(`alias exact proven: ${ledger.alias.exactProven}/${ledger.alias.exactAvailable}, strong rate ${ledger.alias.strongProvenRate.toFixed(3)}`);
  }, (error) => { console.error(error?.stack ?? String(error)); process.exitCode = 2; });
}
