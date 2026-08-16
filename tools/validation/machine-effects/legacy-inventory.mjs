import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../..');
export const DEFAULT_INVENTORY_PATH = path.join(ROOT, 'tests/machine-effects/legacy-arm64-v1-semantic-inventory.json');

function fail(code, detail = '') {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

export function loadLegacyInventory(file = DEFAULT_INVENTORY_PATH) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || parsed.schemaVersion !== 'legacy-arm64-v1-semantic-inventory/v1') fail('legacy-inventory-schema-mismatch');
  return parsed;
}

export function validateLegacyInventory(inventory = loadLegacyInventory(), { root = ROOT } = {}) {
  if (inventory.oracleRole !== 'compatibility-oracle-not-isa-truth') fail('legacy-oracle-role-invalid');
  if (inventory.scope?.legacySemanticSupportOnly !== true) fail('legacy-inventory-scope-invalid');
  if (inventory.scope?.decoderSupportIncluded !== false) fail('legacy-inventory-must-not-claim-decoder-support');
  if (inventory.scope?.newMachineEffectsSupportIncluded !== false) fail('legacy-inventory-must-not-claim-machine-effects-support');
  if (!Array.isArray(inventory.families) || inventory.families.length === 0) fail('legacy-inventory-families-required');

  const sourcePath = path.resolve(root, inventory.sourcePath);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const ids = new Set();
  const mnemonicOwners = new Map();

  for (let index = 0; index < inventory.families.length; index++) {
    const family = inventory.families[index];
    if (!family?.id || ids.has(family.id)) fail('legacy-inventory-family-id-invalid', family?.id || '<missing>');
    ids.add(family.id);
    if (!family.match || typeof family.match !== 'object') fail('legacy-inventory-family-match-required', family.id);
    if (!Array.isArray(family.sourceMarkers) || family.sourceMarkers.length === 0) fail('legacy-inventory-source-markers-required', family.id);
    for (const marker of family.sourceMarkers) {
      if (!source.includes(marker)) fail('legacy-inventory-source-drift', `${family.id}: missing ${marker}`);
    }
    for (const mnemonic of family.match.mnemonics || []) {
      const key = String(mnemonic).toLowerCase();
      if (mnemonicOwners.has(key)) fail('legacy-inventory-mnemonic-overlap', `${key}: ${mnemonicOwners.get(key)} vs ${family.id}`);
      mnemonicOwners.set(key, family.id);
    }
  }

  const fallback = inventory.families.at(-1);
  if (fallback?.match?.fallback !== true || fallback.id !== 'fallback-unknown') fail('legacy-inventory-fallback-must-be-last');
  const emptyFamily = inventory.families.find((family) => family.id === 'legacy-explicit-empty');
  if (!emptyFamily || emptyFamily.legacyBehavior !== 'empty-v1-output') fail('legacy-empty-family-missing');
  if (!String(emptyFamily.semanticWarning || '').includes('not ISA proof')) fail('legacy-empty-warning-required');

  return Object.freeze({
    valid: true,
    sourcePath: inventory.sourcePath,
    sourceBaseline: inventory.sourceBaseline,
    familyCount: inventory.families.length,
    explicitMnemonicCount: mnemonicOwners.size,
    oracleRole: inventory.oracleRole,
  });
}

function immediateValue(op) {
  return op && op.k === 'imm' && op.value != null ? BigInt(op.value) : null;
}

function matchesFamily(family, insn) {
  const match = family.match || {};
  const base = String(insn?.mnemonic || '').toLowerCase();
  if (match.trigger === 'insn.isReturn') return insn?.isReturn === true;
  if (match.trigger === 'insn.isCall') return insn?.isCall === true;
  if (match.trigger === 'insn.memory') return !!insn?.memory;
  if (match.mnemonics?.includes(base)) {
    if (family.id === 'vector-zero-immediate') return immediateValue(insn?.ops?.[1]) === 0n;
    return true;
  }
  if (match.pattern) return new RegExp(match.pattern).test(base);
  if (match.fallback) return true;
  return false;
}

export function classifyLegacyInstruction(insn, inventory = loadLegacyInventory()) {
  for (const family of inventory.families) {
    if (matchesFamily(family, insn)) {
      return Object.freeze({
        familyId: family.id,
        legacyBehavior: family.legacyBehavior,
        oracleRole: inventory.oracleRole,
      });
    }
  }
  fail('legacy-inventory-no-fallback');
}

export function legacyInventoryReport(inventory = loadLegacyInventory()) {
  const counts = { semanticFamilies: 0, emptyCompatibilityFamilies: 0, unknownFallbackFamilies: 0 };
  for (const family of inventory.families) {
    if (family.legacyBehavior === 'empty-v1-output') counts.emptyCompatibilityFamilies++;
    else if (family.id === 'fallback-unknown') counts.unknownFallbackFamilies++;
    else counts.semanticFamilies++;
  }
  return Object.freeze({
    schemaVersion: 'legacy-arm64-v1-semantic-inventory-report/v1',
    oracleRole: inventory.oracleRole,
    sourcePath: inventory.sourcePath,
    scope: inventory.scope,
    counts: Object.freeze(counts),
    families: inventory.families,
    percentagePolicy: 'not-applicable; this inventory reports families, not decoder or ISA coverage percentages',
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inventory = loadLegacyInventory(process.argv[2] || DEFAULT_INVENTORY_PATH);
  validateLegacyInventory(inventory);
  process.stdout.write(`${JSON.stringify(legacyInventoryReport(inventory), null, 2)}\n`);
}
