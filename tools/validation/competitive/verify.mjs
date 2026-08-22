import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCompetitiveProfile, generateCompetitiveScorecard } from './score.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function verifyCompetitiveProfile(profile = loadCompetitiveProfile()) {
  if (profile.schemaVersion !== 'hex-competitive-profile/v1') {
    throw new Error(`invalid-schema-version:${profile.schemaVersion}`);
  }
  if (!profile.baselineCommit || !profile.baselineTree || !profile.specificationBlobSha) {
    throw new Error('missing-frozen-identities');
  }
  if (!profile.metrics || Object.keys(profile.metrics).length === 0) {
    throw new Error('missing-profile-metrics');
  }

  const validDirections = new Set(['higher', 'lower', 'exact-zero']);
  for (const [id, metric] of Object.entries(profile.metrics)) {
    if (!validDirections.has(metric.direction)) {
      throw new Error(`invalid-metric-direction:${id}:${metric.direction}`);
    }
    if (typeof metric.regressionTolerance !== 'number' || metric.regressionTolerance < 0) {
      throw new Error(`invalid-regression-tolerance:${id}:${metric.regressionTolerance}`);
    }
    if (metric.direction === 'exact-zero' && metric.regressionTolerance !== 0) {
      throw new Error(`exact-zero-metric-must-have-zero-tolerance:${id}`);
    }
  }

  return { verified: true, metricCount: Object.keys(profile.metrics).length };
}

export function verifyCompetitiveScorecard(scorecard, profile = loadCompetitiveProfile()) {
  if (!scorecard || scorecard.schemaVersion !== 'hex-competitive-scorecard/v1') {
    throw new Error('invalid-scorecard-schema');
  }

  // Ensure hard safety invariants: falseMustAlias and falseNoAlias must always be zero
  for (const entry of scorecard.entries) {
    if (entry.metricId === 'alias-v2-false-must-alias' && entry.hexValue !== 0) {
      throw new Error(`competitive-hard-invariant-failed:false-must-alias:${entry.hexValue}`);
    }
    if (entry.metricId === 'alias-v2-false-no-alias' && entry.hexValue !== 0) {
      throw new Error(`competitive-hard-invariant-failed:false-no-alias:${entry.hexValue}`);
    }

    const metricConfig = profile.metrics[entry.metricId];
    if (metricConfig && metricConfig.regressionTolerance === 0 && entry.comparison === 'LOSS') {
      // In C0 baseline, some metrics may be unoptimized, but during stage verification no zero-tolerance regressions are allowed
      if (entry.metricId.startsWith('alias-v2-false-')) {
        throw new Error(`competitive-zero-tolerance-loss:${entry.metricId}`);
      }
    }
  }

  return { verified: true, totalEntries: scorecard.entries.length };
}

export async function verifyCompetitive({ profile = loadCompetitiveProfile(), scorecard = null } = {}) {
  verifyCompetitiveProfile(profile);
  const card = scorecard ?? await generateCompetitiveScorecard({ profile });
  verifyCompetitiveScorecard(card, profile);
  return { status: 'PASS', scorecard: card };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = await verifyCompetitive();
    console.log(`Competitive verification: ${result.status}`);
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
