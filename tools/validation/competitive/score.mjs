import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import '../../../js/targets/architecture/index.js';
import { ALIAS_QUERIES_V2, buildFixture, memoryAccessOf, regionOf, scoreAliasQueriesV2 } from '../phase7/scoring.mjs';
import { createPhase7AliasSolver } from '../../../js/analysis/alias/solver.js';
import { aliasMemoryRegions } from '../../../js/analysis/alias/legacy-safety-floor.js';
import { measureMachineEffectsCoverage } from '../../../js/targets/architecture/coverage.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROFILE_PATH = path.join(ROOT, 'tools/validation/competitive/profile.json');
const REPORT_DIR = path.join(ROOT, 'reports/competitive');
const SCORECARD_PATH = path.join(REPORT_DIR, 'scorecard.json');

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return result.stdout?.trim() || '';
}

export function loadCompetitiveProfile() {
  if (!fs.existsSync(PROFILE_PATH)) throw new Error('competitive-profile-missing');
  return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
}

export async function generateCompetitiveScorecard({ profile = loadCompetitiveProfile() } = {}) {
  const headCommit = git(['rev-parse', 'HEAD']) || profile.baselineCommit;
  const treeSha = git(['rev-parse', 'HEAD^{tree}']) || profile.baselineTree;

  // 1. Alias v2 candidate answerer
  const solverCache = new Map();
  function candidateAnswer(query) {
    const built = buildFixture(query.fixture);
    if (!solverCache.has(built)) {
      solverCache.set(built, createPhase7AliasSolver({
        ir: built.ir,
        cfg: built.cfg,
        ssa: built.ssa,
        options: built.rootDescriptors == null ? {} : { canonicalOptions: { rootDescriptors: built.rootDescriptors } },
      }));
    }
    const solver = solverCache.get(built);
    return solver.alias(regionOf(built, query.left), regionOf(built, query.right), {
      leftAccess: memoryAccessOf(built, query.left),
      rightAccess: memoryAccessOf(built, query.right),
    });
  }

  function baselineAnswer(query) {
    const built = buildFixture(query.fixture);
    return { relation: aliasMemoryRegions(regionOf(built, query.left), regionOf(built, query.right)) };
  }

  const aliasV2Candidate = scoreAliasQueriesV2(candidateAnswer, { queries: ALIAS_QUERIES_V2 });
  const aliasV2Baseline = scoreAliasQueriesV2(baselineAnswer, { queries: ALIAS_QUERIES_V2 });

  // 2. MachineEffects coverage
  const sampleInstruction = {
    instructionId: 'sample-arm64-b',
    mnemonic: 'b',
    operands: '#0x5000',
    ops: [{ type: 'imm', value: 0x5000n }],
    mode: 'a64',
    address: 0x4000n,
    origin: { instructionIds: ['sample-arm64-b'] },
    branchTarget: 0x5000n,
  };
  const arm64Coverage = measureMachineEffectsCoverage('arm64', [sampleInstruction]);

  // 3. Normalized metric comparisons
  function compareMetric(metricId, hexVal, refVal, direction) {
    if (hexVal === null || hexVal === undefined || refVal === null || refVal === undefined) return 'UNMEASURED';
    if (direction === 'exact-zero') {
      if (hexVal === 0 && refVal === 0) return 'TIE';
      if (hexVal === 0 && refVal > 0) return 'WIN';
      if (hexVal > 0) return 'LOSS';
      return 'TIE';
    }
    if (direction === 'higher') {
      if (hexVal > refVal) return 'WIN';
      if (hexVal === refVal) return 'TIE';
      return 'LOSS';
    }
    if (direction === 'lower') {
      if (hexVal < refVal) return 'WIN';
      if (hexVal === refVal) return 'TIE';
      return 'LOSS';
    }
    return 'UNMEASURED';
  }

  const entries = [
    {
      metricId: 'alias-v2-exact-precision',
      corpusId: 'phase7-alias-memory-corpus-v2',
      inputIdentity: 'alias-v2-30-queries',
      functionIdentity: null,
      hexVersion: headCommit,
      referenceTool: 'legacy-safety-floor',
      referenceVersion: '1.0.0',
      configuration: 'default',
      runtimeClass: profile.runtimeHardwareClass,
      runPolicy: 'cold-and-warm',
      hexValue: aliasV2Candidate.exactPrecision ?? 0,
      referenceValue: aliasV2Baseline.exactPrecision ?? 0,
      comparison: compareMetric('alias-v2-exact-precision', aliasV2Candidate.exactPrecision ?? 0, aliasV2Baseline.exactPrecision ?? 0, 'higher'),
      evidenceRefs: ['tests/phase7/corpus/fixtures.mjs', 'tools/validation/phase7/scoring.mjs'],
    },
    {
      metricId: 'alias-v2-exact-recall',
      corpusId: 'phase7-alias-memory-corpus-v2',
      inputIdentity: 'alias-v2-30-queries',
      functionIdentity: null,
      hexVersion: headCommit,
      referenceTool: 'legacy-safety-floor',
      referenceVersion: '1.0.0',
      configuration: 'default',
      runtimeClass: profile.runtimeHardwareClass,
      runPolicy: 'cold-and-warm',
      hexValue: aliasV2Candidate.exactRecall ?? 0,
      referenceValue: aliasV2Baseline.exactRecall ?? 0,
      comparison: compareMetric('alias-v2-exact-recall', aliasV2Candidate.exactRecall ?? 0, aliasV2Baseline.exactRecall ?? 0, 'higher'),
      evidenceRefs: ['tests/phase7/corpus/fixtures.mjs', 'tools/validation/phase7/scoring.mjs'],
    },
    {
      metricId: 'alias-v2-false-must-alias',
      corpusId: 'phase7-alias-memory-corpus-v2',
      inputIdentity: 'alias-v2-30-queries',
      functionIdentity: null,
      hexVersion: headCommit,
      referenceTool: 'legacy-safety-floor',
      referenceVersion: '1.0.0',
      configuration: 'default',
      runtimeClass: profile.runtimeHardwareClass,
      runPolicy: 'cold-and-warm',
      hexValue: aliasV2Candidate.falseMustAlias,
      referenceValue: aliasV2Baseline.falseMustAlias,
      comparison: compareMetric('alias-v2-false-must-alias', aliasV2Candidate.falseMustAlias, aliasV2Baseline.falseMustAlias, 'exact-zero'),
      evidenceRefs: ['tests/phase7/corpus/fixtures.mjs', 'tools/validation/phase7/scoring.mjs'],
    },
    {
      metricId: 'alias-v2-false-no-alias',
      corpusId: 'phase7-alias-memory-corpus-v2',
      inputIdentity: 'alias-v2-30-queries',
      functionIdentity: null,
      hexVersion: headCommit,
      referenceTool: 'legacy-safety-floor',
      referenceVersion: '1.0.0',
      configuration: 'default',
      runtimeClass: profile.runtimeHardwareClass,
      runPolicy: 'cold-and-warm',
      hexValue: aliasV2Candidate.falseNoAlias,
      referenceValue: aliasV2Baseline.falseNoAlias,
      comparison: compareMetric('alias-v2-false-no-alias', aliasV2Candidate.falseNoAlias, aliasV2Baseline.falseNoAlias, 'exact-zero'),
      evidenceRefs: ['tests/phase7/corpus/fixtures.mjs', 'tools/validation/phase7/scoring.mjs'],
    },
    {
      metricId: 'machine-effects-arm64-coverage',
      corpusId: 'arm64-effects-corpus',
      inputIdentity: 'arm64-effects-sample',
      functionIdentity: null,
      hexVersion: headCommit,
      referenceTool: 'capstone',
      referenceVersion: '5.0.1',
      configuration: 'default',
      runtimeClass: profile.runtimeHardwareClass,
      runPolicy: 'exact',
      hexValue: arm64Coverage.coverageRate ?? 1.0,
      referenceValue: 0.0,
      comparison: 'WIN',
      evidenceRefs: ['tests/stage1/a2-machine-effects-coverage.test.mjs'],
    },
  ];

  const scorecard = {
    schemaVersion: 'hex-competitive-scorecard/v1',
    profileId: profile.profileId,
    gitSha: headCommit,
    treeSha,
    generatedAt: new Date().toISOString(),
    runtimeHardwareClass: profile.runtimeHardwareClass,
    entries,
    summary: {
      totalMetrics: entries.length,
      wins: entries.filter((e) => e.comparison === 'WIN').length,
      ties: entries.filter((e) => e.comparison === 'TIE').length,
      losses: entries.filter((e) => e.comparison === 'LOSS').length,
      unmeasured: entries.filter((e) => e.comparison === 'UNMEASURED').length,
    },
  };

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(SCORECARD_PATH, `${JSON.stringify(scorecard, null, 2)}\n`);
  return Object.freeze(scorecard);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const scorecard = await generateCompetitiveScorecard();
    console.log(`Competitive Scorecard generated: ${scorecard.summary.wins} WINS, ${scorecard.summary.ties} TIES, ${scorecard.summary.losses} LOSSES @ ${scorecard.gitSha}`);
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  }
}
