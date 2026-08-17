from pathlib import Path

# Keep the semantic-v2 corpus proof isolated: restore the caller's migration
# mode instead of leaking legacy-v1 into the later release-report test.
p = Path('tests/semantic-v2/integration-current-corpus.test.mjs')
s = p.read_text()
old_import = """  buildIR,
  getLastSemanticV2Instrumentation,
  setSemanticMigrationMode,
} from '../../js/ir.js';"""
new_import = """  buildIR,
  getLastSemanticV2Instrumentation,
  getSemanticMigrationMode,
  setSemanticMigrationMode,
} from '../../js/ir.js';"""
if s.count(old_import) != 1:
    raise SystemExit(f'current-corpus import shape mismatch: {s.count(old_import)}')
s = s.replace(old_import, new_import, 1)
old_mode = """const proofModel = buildSemanticModel(rows, { startRow:0, endRow:rows.length - 1, rowOfAddress });
setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);"""
new_mode = """const proofModel = buildSemanticModel(rows, { startRow:0, endRow:rows.length - 1, rowOfAddress });
const initialMigrationMode = getSemanticMigrationMode();
setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.V2_COMPAT);"""
if s.count(old_mode) != 1:
    raise SystemExit(f'current-corpus initial mode shape mismatch: {s.count(old_mode)}')
s = s.replace(old_mode, new_mode, 1)
old_restore = "setSemanticMigrationMode(SEMANTIC_V2_MIGRATION_MODES.LEGACY);"
if s.count(old_restore) != 1:
    raise SystemExit(f'current-corpus restore shape mismatch: {s.count(old_restore)}')
s = s.replace(old_restore, "setSemanticMigrationMode(initialMigrationMode);", 1)
p.write_text(s)

# External evidence is not a pass merely because a subset of workflows says
# PASS. Require the exact product/base identity, every required gate including
# Universal Platform, each real-binary oracle, and a canonical generated buildId.
p = Path('tests/semantic-v2/integration-release-report.test.mjs')
s = p.read_text()
old = """const requiredExternalKeys = ['crossBinaryAccuracy','ghidraDifferential','userscriptHost','semanticIrV2','invariantGates','migrationGuardrails','machineEffects','phase2Integration','runtimeDebugger','irDataflow'];
const externalPassed = externalEvidence?.status === 'pass'
  && requiredExternalKeys.every((key) => externalEvidence?.gates?.[key]?.result === 'PASS');"""
new = """const requiredExternalKeys = ['crossBinaryAccuracy','ghidraDifferential','userscriptHost','semanticIrV2','invariantGates','migrationGuardrails','machineEffects','phase2Integration','runtimeDebugger','irDataflow','universalPlatform'];
const externalIdentityComplete = typeof externalEvidence?.validatedHeadSha === 'string'
  && /^[0-9a-f]{40}$/.test(externalEvidence.validatedHeadSha)
  && typeof externalEvidence?.baseSha === 'string'
  && /^[0-9a-f]{40}$/.test(externalEvidence.baseSha);
const externalRealBinariesPassed = externalEvidence?.realBinaries?.battleCats === 'PASS'
  && externalEvidence?.realBinaries?.tsumTsum === 'PASS'
  && externalEvidence?.realBinaries?.ywp === 'PASS';
const externalUserscriptBuildIdPresent = typeof externalEvidence?.userscriptBuildId === 'string'
  && /^[0-9a-f]{24}$/.test(externalEvidence.userscriptBuildId);
const externalPassed = externalEvidence?.status === 'pass'
  && externalIdentityComplete
  && externalRealBinariesPassed
  && externalUserscriptBuildIdPresent
  && requiredExternalKeys.every((key) => externalEvidence?.gates?.[key]?.result === 'PASS'
    && Number.isSafeInteger(externalEvidence?.gates?.[key]?.runId)
    && externalEvidence.gates[key].runId > 0);"""
if s.count(old) != 1:
    raise SystemExit(f'release-report external gate shape mismatch: {s.count(old)}')
s = s.replace(old, new, 1)
old_report = """  externalValidatedHeadSha: externalEvidence?.validatedHeadSha ?? null,
  defaultSemanticMigrationMode: getSemanticMigrationMode(),"""
new_report = """  externalValidatedHeadSha: externalEvidence?.validatedHeadSha ?? null,
  externalBaseSha: externalEvidence?.baseSha ?? null,
  userscriptBuildId: externalEvidence?.userscriptBuildId ?? null,
  defaultSemanticMigrationMode: getSemanticMigrationMode(),"""
if s.count(old_report) != 1:
    raise SystemExit(f'release-report identity output shape mismatch: {s.count(old_report)}')
s = s.replace(old_report, new_report, 1)
p.write_text(s)
