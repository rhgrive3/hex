import { asArray, makeResult, stableStringify } from './core.mjs';

function blockMap(cfg) {
  return new Map(asArray(cfg?.blocks).map((block) => [String(block.id), {
    id: String(block.id),
    predecessors: asArray(block.predecessors).map(String),
    successors: asArray(block.successors).map(String),
  }]));
}

export function computeDominators(cfg) {
  const blocks = blockMap(cfg);
  const entry = String(cfg?.entryBlockId ?? '');
  if (!blocks.has(entry)) throw new Error('ssa-oracle-entry-block-missing');
  const all = new Set(blocks.keys());
  const dom = new Map();
  for (const id of blocks.keys()) dom.set(id, id === entry ? new Set([id]) : new Set(all));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, block] of blocks) {
      if (id === entry) continue;
      const predecessors = block.predecessors.filter((pred) => blocks.has(pred));
      const next = new Set([id]);
      if (predecessors.length) {
        let intersection = new Set(dom.get(predecessors[0]));
        for (const pred of predecessors.slice(1)) intersection = new Set([...intersection].filter((value) => dom.get(pred).has(value)));
        for (const value of intersection) next.add(value);
      }
      if (stableStringify([...next].sort()) !== stableStringify([...dom.get(id)].sort())) {
        dom.set(id, next);
        changed = true;
      }
    }
  }
  return dom;
}

function defKey(definition) {
  return `${definition.variableKey ?? ''}@${definition.blockId ?? '<entry>'}:${definition.kind}`;
}

function findDefinition(definitions, expected) {
  return definitions.find((definition) =>
    String(definition.variableKey ?? '') === String(expected.variableKey ?? '')
    && String(definition.blockId ?? '') === String(expected.blockId ?? '')
    && String(definition.kind) === String(expected.kind));
}

function definitionByValue(output) {
  return new Map(asArray(output.definitions).map((definition) => [String(definition.valueId), definition]));
}

function useByEntity(output) {
  return new Map(asArray(output.uses).map((use) => [String(use.sourceEntityId), use]));
}

function validateLinkIndexes(output, errors) {
  const definitions = asArray(output.definitions);
  const uses = asArray(output.uses);
  const defsByValue = definitionByValue(output);
  const expectedUseDef = uses.map((use) => ({ useId: String(use.useId), valueId: String(use.valueId), definitionId: String(defsByValue.get(String(use.valueId))?.definitionId ?? '') }))
    .sort((a, b) => a.useId.localeCompare(b.useId));
  const actualUseDef = asArray(output.useDefLinks).map((link) => ({ useId: String(link.useId), valueId: String(link.valueId), definitionId: String(link.definitionId) }))
    .sort((a, b) => a.useId.localeCompare(b.useId));
  if (stableStringify(expectedUseDef) !== stableStringify(actualUseDef)) errors.push('use-def index does not match definitions/uses');

  const expectedDefUse = definitions.map((definition) => ({
    definitionId: String(definition.definitionId),
    valueId: String(definition.valueId),
    useIds: uses.filter((use) => String(use.valueId) === String(definition.valueId)).map((use) => String(use.useId)).sort(),
  })).sort((a, b) => a.definitionId.localeCompare(b.definitionId));
  const actualDefUse = asArray(output.defUseLinks).map((link) => ({
    definitionId: String(link.definitionId), valueId: String(link.valueId), useIds: asArray(link.useIds).map(String).sort(),
  })).sort((a, b) => a.definitionId.localeCompare(b.definitionId));
  if (stableStringify(expectedDefUse) !== stableStringify(actualDefUse)) errors.push('def-use index does not match definitions/uses');
}

export function verifySsaCase(testCase, output) {
  const errors = [];
  const definitions = asArray(output?.definitions);
  const uses = asArray(output?.uses);
  const defsByValue = definitionByValue(output ?? {});
  const usesByEntity = useByEntity(output ?? {});
  const dominators = computeDominators(testCase.cfg);

  for (const expected of asArray(testCase.expected?.definitions)) {
    const actual = findDefinition(definitions, expected);
    if (!actual) {
      errors.push(`missing definition ${expected.variableKey}@${expected.blockId ?? '<entry>'}:${expected.kind}`);
      continue;
    }
    if (expected.sourceEntityId != null && String(actual.sourceEntityId ?? '') !== String(expected.sourceEntityId)) {
      errors.push(`definition ${defKey(actual)} has wrong source entity`);
    }
    if (expected.kind === 'phi') {
      const incoming = asArray(actual.incoming);
      const expectedPreds = asArray(expected.incoming).map((item) => String(item.predecessorBlockId)).sort();
      const actualPreds = incoming.map((item) => String(item.predecessorBlockId)).sort();
      if (stableStringify(expectedPreds) !== stableStringify(actualPreds)) errors.push(`phi ${expected.variableKey}@${expected.blockId} has wrong predecessor set`);
      for (const expectedIncoming of asArray(expected.incoming)) {
        const actualIncoming = incoming.find((item) => String(item.predecessorBlockId) === String(expectedIncoming.predecessorBlockId));
        if (!actualIncoming) continue;
        const incomingDef = defsByValue.get(String(actualIncoming.valueId));
        if (!incomingDef) {
          errors.push(`phi ${expected.variableKey}@${expected.blockId} has dangling incoming value`);
          continue;
        }
        if (String(incomingDef.variableKey ?? '') !== String(expected.variableKey)) errors.push(`phi ${expected.variableKey}@${expected.blockId} mixes variable identities`);
        if (expectedIncoming.fromBlockId != null && String(incomingDef.blockId ?? '') !== String(expectedIncoming.fromBlockId)) {
          errors.push(`phi ${expected.variableKey}@${expected.blockId} has wrong reaching definition for ${expectedIncoming.predecessorBlockId}`);
        }
        if (expectedIncoming.fromKind != null && String(incomingDef.kind) !== String(expectedIncoming.fromKind)) {
          errors.push(`phi ${expected.variableKey}@${expected.blockId} has wrong incoming kind for ${expectedIncoming.predecessorBlockId}`);
        }
      }
    }
  }

  const expectedDefinitionCount = asArray(testCase.expected?.definitions).length;
  if (testCase.expected?.exactDefinitionCount !== false && definitions.length !== expectedDefinitionCount) {
    errors.push(`definition count ${definitions.length} != oracle ${expectedDefinitionCount}`);
  }

  for (const expectedUse of asArray(testCase.expected?.uses)) {
    const use = usesByEntity.get(String(expectedUse.sourceEntityId));
    if (!use) {
      errors.push(`missing use ${expectedUse.sourceEntityId}`);
      continue;
    }
    const reaching = defsByValue.get(String(use.valueId));
    if (!reaching) {
      errors.push(`use ${expectedUse.sourceEntityId} has no reaching definition`);
      continue;
    }
    if (String(reaching.variableKey ?? '') !== String(expectedUse.variableKey)) errors.push(`use ${expectedUse.sourceEntityId} reaches wrong variable`);
    if (expectedUse.reachingBlockId != null && String(reaching.blockId ?? '') !== String(expectedUse.reachingBlockId)) errors.push(`use ${expectedUse.sourceEntityId} reaches wrong block`);
    if (expectedUse.reachingKind != null && String(reaching.kind) !== String(expectedUse.reachingKind)) errors.push(`use ${expectedUse.sourceEntityId} reaches wrong definition kind`);
    if (reaching.kind !== 'phi' && reaching.blockId != null && use.blockId != null) {
      const useDom = dominators.get(String(use.blockId));
      if (!useDom?.has(String(reaching.blockId))) errors.push(`reaching definition for ${expectedUse.sourceEntityId} does not dominate the use`);
    }
  }

  for (const relation of asArray(testCase.expected?.dominance)) {
    const [dominator, dominated] = relation.map(String);
    if (!dominators.get(dominated)?.has(dominator)) errors.push(`oracle CFG dominance failed: ${dominator} !dom ${dominated}`);
  }

  validateLinkIndexes(output ?? {}, errors);
  return makeResult(testCase.name, errors.length === 0, { errors: Object.freeze(errors) });
}

export async function runSsaOracle({ adapter, cases = createSsaOracleCases() } = {}) {
  if (!adapter || typeof adapter.buildSsa !== 'function') {
    return Object.freeze({ integrated: false, blocking: true, reason: 'ssa-adapter-not-integrated', cases: Object.freeze([]), passed: 0, failed: cases.length });
  }
  const results = [];
  for (const testCase of cases) {
    try {
      const output = await adapter.buildSsa(testCase.program, testCase.cfg, { caseName: testCase.name });
      results.push(verifySsaCase(testCase, output));
    } catch (error) {
      results.push(makeResult(testCase.name, false, { errors: Object.freeze([`adapter threw: ${error?.message ?? error}`]) }));
    }
  }
  const failed = results.filter((result) => !result.passed).length;
  return Object.freeze({ integrated: true, blocking: failed > 0, cases: Object.freeze(results), passed: results.length - failed, failed });
}

export function createSsaOracleCases() {
  return Object.freeze([
    Object.freeze({
      name: 'linear-reaching-definition',
      cfg: { entryBlockId: 'b0', blocks: [
        { id: 'b0', predecessors: [], successors: ['b1'] },
        { id: 'b1', predecessors: ['b0'], successors: [] },
      ] },
      program: { blocks: [
        { id: 'b0', operations: [{ kind: 'def', variableKey: 'v', sourceEntityId: 'def-v' }] },
        { id: 'b1', operations: [{ kind: 'use', variableKey: 'v', sourceEntityId: 'use-v' }] },
      ] },
      expected: {
        definitions: [{ variableKey: 'v', blockId: 'b0', kind: 'definition', sourceEntityId: 'def-v' }],
        uses: [{ variableKey: 'v', sourceEntityId: 'use-v', reachingBlockId: 'b0', reachingKind: 'definition' }],
        dominance: [['b0', 'b1']],
      },
    }),
    Object.freeze({
      name: 'diamond-phi-placement',
      cfg: { entryBlockId: 'entry', blocks: [
        { id: 'entry', predecessors: [], successors: ['left','right'] },
        { id: 'left', predecessors: ['entry'], successors: ['merge'] },
        { id: 'right', predecessors: ['entry'], successors: ['merge'] },
        { id: 'merge', predecessors: ['left','right'], successors: [] },
      ] },
      program: { blocks: [
        { id: 'entry', operations: [] },
        { id: 'left', operations: [{ kind: 'def', variableKey: 'v', sourceEntityId: 'left-v' }] },
        { id: 'right', operations: [{ kind: 'def', variableKey: 'v', sourceEntityId: 'right-v' }] },
        { id: 'merge', operations: [{ kind: 'use', variableKey: 'v', sourceEntityId: 'merge-use' }] },
      ] },
      expected: {
        definitions: [
          { variableKey: 'v', blockId: 'left', kind: 'definition', sourceEntityId: 'left-v' },
          { variableKey: 'v', blockId: 'right', kind: 'definition', sourceEntityId: 'right-v' },
          { variableKey: 'v', blockId: 'merge', kind: 'phi', incoming: [
            { predecessorBlockId: 'left', fromBlockId: 'left', fromKind: 'definition' },
            { predecessorBlockId: 'right', fromBlockId: 'right', fromKind: 'definition' },
          ] },
        ],
        uses: [{ variableKey: 'v', sourceEntityId: 'merge-use', reachingBlockId: 'merge', reachingKind: 'phi' }],
        dominance: [['entry','left'],['entry','right'],['entry','merge']],
      },
    }),
    Object.freeze({
      name: 'loop-carried-phi',
      cfg: { entryBlockId: 'entry', blocks: [
        { id: 'entry', predecessors: [], successors: ['header'] },
        { id: 'header', predecessors: ['entry','body'], successors: ['body','exit'] },
        { id: 'body', predecessors: ['header'], successors: ['header'] },
        { id: 'exit', predecessors: ['header'], successors: [] },
      ] },
      program: { blocks: [
        { id: 'entry', operations: [{ kind: 'def', variableKey: 'i', sourceEntityId: 'init-i' }] },
        { id: 'header', operations: [{ kind: 'use', variableKey: 'i', sourceEntityId: 'header-use' }] },
        { id: 'body', operations: [{ kind: 'def', variableKey: 'i', sourceEntityId: 'step-i' }] },
        { id: 'exit', operations: [{ kind: 'use', variableKey: 'i', sourceEntityId: 'exit-use' }] },
      ] },
      expected: {
        definitions: [
          { variableKey: 'i', blockId: 'entry', kind: 'definition', sourceEntityId: 'init-i' },
          { variableKey: 'i', blockId: 'header', kind: 'phi', incoming: [
            { predecessorBlockId: 'entry', fromBlockId: 'entry', fromKind: 'definition' },
            { predecessorBlockId: 'body', fromBlockId: 'body', fromKind: 'definition' },
          ] },
          { variableKey: 'i', blockId: 'body', kind: 'definition', sourceEntityId: 'step-i' },
        ],
        uses: [
          { variableKey: 'i', sourceEntityId: 'header-use', reachingBlockId: 'header', reachingKind: 'phi' },
          { variableKey: 'i', sourceEntityId: 'exit-use', reachingBlockId: 'header', reachingKind: 'phi' },
        ],
        dominance: [['entry','header'],['header','body'],['header','exit']],
      },
    }),
    Object.freeze({
      name: 'explicit-undef',
      cfg: { entryBlockId: 'entry', blocks: [
        { id: 'entry', predecessors: [], successors: ['use'] },
        { id: 'use', predecessors: ['entry'], successors: [] },
      ] },
      program: { blocks: [
        { id: 'entry', operations: [] },
        { id: 'use', operations: [{ kind: 'use', variableKey: 'missing', sourceEntityId: 'undef-use' }] },
      ] },
      expected: {
        definitions: [{ variableKey: 'missing', blockId: null, kind: 'undef' }],
        uses: [{ variableKey: 'missing', sourceEntityId: 'undef-use', reachingBlockId: null, reachingKind: 'undef' }],
        dominance: [['entry','use']],
      },
    }),
  ]);
}
