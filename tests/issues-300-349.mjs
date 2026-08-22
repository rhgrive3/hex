import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { expr, nodeCount, structuralKey } from '../js/decompiler/ast/nodes.js';
import { printExpression } from '../js/decompiler/pretty/c.js';
import { PassManager } from '../js/decompiler/passes/manager.js';
import { recoverHighVariables } from '../js/decompiler/types/high-variables.js';
import { TraceRingBuffer } from '../js/trace/ring-buffer.js';
import {
  createHexProject, serializeHexProject, importHexProject, MAX_PROJECT_BYTES,
} from '../js/project/index.js';
import { buildObjcRuntimeIndex, resolveObjcDispatch } from '../js/apple/objc-runtime.js';

const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// #342: an exhausted global deadline must stop optional work rather than merely
// annotating it after it has already run.
{
  let optionalRuns = 0;
  let requiredRuns = 0;
  const pm = new PassManager([
    { name: 'optional', run() { optionalRuns++; }, required: false },
    { name: 'finalize', run() { requiredRuns++; }, required: true },
  ], { timeBudgetMs: 0 });
  const state = pm.run({});
  assert.equal(optionalRuns, 0);
  assert.equal(requiredRuns, 1);
  assert.equal(state.degraded, true);
  assert.ok(state.passMetrics.some((m) => m.name === 'optional' && m.skipped));
}

// #343/#344: type semantics participate in identity and deep ASTs are traversed
// iteratively instead of overflowing the JavaScript stack.
{
  assert.notEqual(
    structuralKey(expr.constant(1n, 32, false)),
    structuralKey(expr.constant(1n, 64, false)),
  );
  assert.notEqual(
    structuralKey(expr.variable('v', 64, true)),
    structuralKey(expr.variable('v', 64, false)),
  );
  let deep = expr.variable('x');
  for (let i = 0; i < 12000; i++) deep = expr.unary('not', deep);
  assert.equal(nodeCount(deep), 12001);
  assert.match(structuralKey(deep), /^u:not:/);
}

// #346/#347: MADD/MSUB obey C precedence and >64-bit literals keep all bits.
{
  const a = expr.variable('a'), b = expr.variable('b'), c = expr.variable('c'), d = expr.variable('d');
  const madd = expr.intrinsic('madd', [a, b, c]);
  assert.equal(printExpression(expr.binary('mul', madd, d)), '(a * b + c) * d');
  const wide = (1n << 100n) | 0x1234n;
  const text = printExpression(expr.constant(wide, 128, false));
  assert.match(text, /unsigned __int128/);
  assert.match(text, /1000000000/); // high chunk is present; value was not truncated to uint64.
  assert.match(text, /1234ULL/);
}

// #349: physical register reuse alone is never HighVariable identity.
{
  const ir = {
    values: [
      { id: 'v1', kind: 'reg', reg: 'x0', uses: [] },
      { id: 'v2', kind: 'reg', reg: 'x0', uses: [] },
      { id: 'a0.1', kind: 'arg', reg: 'x0', n: 0, uses: [] },
      { id: 'a0.2', kind: 'arg', reg: 'x0', n: 0, uses: [] },
    ],
    instructions: [],
  };
  const recovered = recoverHighVariables(ir, { values: new Map() });
  assert.notEqual(recovered.valueToGroup.get('v1'), recovered.valueToGroup.get('v2'));
  assert.equal(recovered.valueToGroup.get('a0.1'), recovered.valueToGroup.get('a0.2'));
}

// #322: trace ingestion/snapshots own their nested data.
{
  const buffer = new TraceRingBuffer({ maxEvents: 16 });
  const original = { type: 'instruction', nested: { regs: [1, 2] } };
  assert.equal(buffer.push(original), true);
  original.nested.regs[0] = 99;
  const first = buffer.snapshot();
  assert.equal(first.events[0].nested.regs[0], 1);
  first.events[0].nested.regs[1] = 77;
  assert.equal(buffer.snapshot().events[0].nested.regs[1], 2);
}

// #326/#327: project size is a hard boundary on both output and Blob input,
// before Blob.text() materializes an oversized string.
{
  const project = createHexProject({ comments: [{ text: 'x'.repeat(MAX_PROJECT_BYTES + 1024) }] });
  assert.throws(() => serializeHexProject(project), /16 MiB/);
  // importHexProject reads bytes rather than Blob.text() (#1388), so probe the
  // method it actually calls -- otherwise this assertion would pass vacuously
  // and stop enforcing that the size boundary fires before materialization.
  let materialized = false;
  class ProbeBlob extends Blob {
    async text() { materialized = true; return super.text(); }
    async arrayBuffer() { materialized = true; return super.arrayBuffer(); }
  }
  const blob = new ProbeBlob(['x'.repeat(MAX_PROJECT_BYTES + 1)]);
  await assert.rejects(importHexProject(blob), /16 MiB/);
  assert.equal(materialized, false);
}

// #324: explicit receiver type is a hard contradiction, not permission to fall
// back to an unrelated class that happens to implement the selector.
{
  const index = buildObjcRuntimeIndex({
    classes: [
      { name: 'A', methods: [] },
      { name: 'B', methods: [{ selector: 'foo', addr: 0x1000n }] },
    ],
  });
  const result = resolveObjcDispatch(index, { receiverType: 'A', selector: 'foo' });
  assert.equal(result.resolved, null);
  assert.equal(result.candidates.length, 0);
  assert.match(result.reason, /contradict/);
}

// Cross-cutting regression assertions for parser/UI paths whose useful public
// fixture setup would otherwise duplicate the whole application worker/runtime.
{
  const comprehend = await source('js/comprehend.js');
  assert.match(comprehend, /formulaKey\(use\.kind, use\.v\)/);                 // #300
  assert.match(comprehend, /semanticRank\(b\.value\) - semanticRank\(a\.value\)/); // #301
  assert.match(comprehend, /const successors = \(insn\)/);                    // #302

  const exprSource = await source('js/expr.js');
  assert.match(exprSource, /base === 'ccmp' \|\| base === 'ccmn'/);            // #303
  assert.match(exprSource, /flags = null; \/\/ NZCV is caller-clobbered/);    // #304
  assert.match(exprSource, /if \(base === 'cinc'\)/);                         // #305
  assert.match(exprSource, /v = un\('uxt32', v\)/);                           // #306/#308
  assert.match(exprSource, /fadd: 'fadd'/);                                    // #307
  assert.match(exprSource, /indexShift:/);                                     // #309/#310
  assert.match(exprSource, /const variableShift/);                             // #311

  const report = await source('js/report.js');
  assert.match(report, /independentEvidenceGroups/);                           // #313

  const worker = await source('js/worker.js');
  assert.match(worker, /function-start-cap-reached/);                          // #314
  assert.match(worker, /complete: !capped/);

  const plugins = await source('js/plugins.js');
  assert.match(plugins, /res\.body\.getReader/);                               // #315
  assert.match(plugins, /this\.plugins = before/);                             // #316

  const arm64 = await source('js/arm64.js');
  assert.match(arm64, /writebackDisp/);                                        // #317
  assert.match(arm64, /addressDisp/);

  const linkage = await source('js/linkage.js');
  assert.doesNotMatch(linkage, /i \+= step/);                                  // #318
  assert.match(linkage, /declaredSize \?\? r\.size/);                         // #319

  const dataflow = await source('js/dataflow-semantic.js');
  assert.match(dataflow, /PROPERTY_HELPER_ABI/);                               // #323
  assert.match(dataflow, /getProperty: Object\.freeze\(\{ kind: 'read', offsetReg: 'x2', valueReg: 'x0' \}\)/);
  assert.match(dataflow, /setProperty: Object\.freeze\(\{ kind: 'write', offsetReg: 'x2', valueReg: 'x3' \}\)/);
  assert.match(dataflow, /register: abi\.valueReg/);

  const emu = await source('js/emu.js');
  assert.match(emu, /type:'call'.*target.*indirect/s);                         // #325

  const features = await source('js/features.js');
  assert.match(features, /item\.score > list\[list\.length - 1\]\.score/);    // #328

  const graph = await source('js/graphview.js');
  assert.match(graph, /const backEdges = new Set/);                            // #329
  assert.doesNotMatch(graph, /ti <= b\.index/);
  assert.match(graph, /suppressClick/);                                        // #330

  const tools = await source('js/tools.js');
  assert.match(tools, /f\.size > MAX_PLUGIN_SOURCE_BYTES/);                    // #331
  assert.match(tools, /parseDebuggerArgument/);                                // #332
  assert.doesNotMatch(tools, /catch \{ return 0n; \}/);

  const vendors = await source('js/vendors.js');
  assert.match(vendors, /vendor\.via === 'cluster'/);                          // #333

  const rank = await source('js/rank.js');
  assert.match(rank, /matches\.sort\(/);                                      // #334
  assert.match(rank, /matches\.slice\(0, 400\)/);

  const viewer = await source('js/viewer.js');
  const actions = await source('js/ai/interaction/actions.js');
  assert.match(viewer, /rowOfAddress\(addr\)/);                                // #335
  assert.doesNotMatch(actions, /\/ 4n/);

  const normalize = await source('js/ai/render/normalize.js');
  assert.doesNotMatch(normalize, /n >= 0\.95\) return STATUS\.VERIFIED/);       // #336
  assert.match(normalize, /unresolvedEvidenceIds/);                            // #337

  const elf = await source('js/binary/elf.js');
  assert.match(elf, /ph\.filesz > ph\.memsz/);                                // #338

  const pe = await source('js/binary/pe-loader.js');
  assert.match(pe, /derivedFunction/);                                         // #339
  assert.match(pe, /confidence: 0\.55/);

  const macho = await source('js/binary/macho.js');
  assert.match(macho, /validateSectionRange/);                                 // #340
  assert.match(macho, /invalid LC_FUNCTION_STARTS entry/);                     // #341

  const rules = await source('js/decompiler/rewrite/rules.js');
  assert.match(rules, /isConst\(n\.right, 0\) && isPure\(n\.left\)/);          // #345

  const pipeline = await source('js/decompiler/pipeline-core.js');
  assert.match(pipeline, /expression: access, text: printExpression\(access\)/); // #348
}

console.log('issues #300-#349 regression suite: ok');
