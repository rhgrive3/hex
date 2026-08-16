import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INTEGRATION_STATE,
  assertCoverageFullyAccounted,
  summarizeCoverage,
} from './coverage-model.mjs';
import {
  inspectExternalOracleInfrastructure,
  assertExternalOraclePolicy,
} from './external-oracles.mjs';
import {
  loadLegacyInventory,
  validateLegacyInventory,
  legacyInventoryReport,
} from './legacy-inventory.mjs';

export function createVerificationReport({
  coverageRecords = [],
  differential = null,
  integrationState = INTEGRATION_STATE.NOT_INTEGRATED,
} = {}) {
  const inventory = loadLegacyInventory();
  const legacyValidation = validateLegacyInventory(inventory);
  const legacy = legacyInventoryReport(inventory);
  const externalOracles = inspectExternalOracleInfrastructure();
  assertExternalOraclePolicy(externalOracles);
  const coverage = summarizeCoverage(coverageRecords, { integrationState });
  assertCoverageFullyAccounted(coverage);

  return Object.freeze({
    schemaVersion: 'machine-effects-verification-report/v1',
    integrationState,
    integrationBlocking: integrationState !== INTEGRATION_STATE.INTEGRATED,
    legacyInventoryValidation: legacyValidation,
    legacy,
    coverage,
    differential,
    externalOracles,
    policy: Object.freeze({
      legacyV1: 'compatibility-oracle-not-isa-truth',
      capstone: 'decoder-evidence-only',
      missingIntegration: 'reported-as-not-integrated-and-never-counted-as-pass',
      unknown: 'explicit-count-never-hidden-by-percentage',
      productionSemanticsOwnedHere: false,
    }),
  });
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  const report = createVerificationReport();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
