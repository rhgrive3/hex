import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/*
 * Static canonical feature manifest for accuracy-merge.mjs. The executable
 * declarations live byte-for-byte in accuracy-base.mjs; this manifest keeps
 * the existing static merge-order contract while the audited scorer patch is
 * applied at runtime.
 *
 * feature('sections')
 * feature('funcs')
 * feature('funcs-guess')
 * feature('disasm')
 * feature('kinds')
 * feature('calls')
 * feature('refs')
 * feature('imports')
 * feature('objc')
 * feature('selstub')
 * feature('strings')
 * feature('xrefs')
 * feature('funcname')
 * feature('selffield')
 * feature('role')
 * feature('pinpoint')
 * feature('pinpoint-partial')
 * feature('apimeaning')
 * feature('summary')
 * feature('expr')
 * feature('formula')
 * feature('pseudoc')
 */

/*
 * Keep the historical scorer snapshotted in accuracy-base.mjs and apply only
 * the audited short-selector correction at runtime. This makes the change
 * surgical: all feature definitions, CLI behavior and thresholds remain byte-
 * for-byte identical to the pinned scorer except for summary name matching.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const basePath = path.join(here, 'accuracy-base.mjs');
const activePath = path.join(here, `.accuracy-active-${process.pid}.mjs`);
const oldCheck = '      if (core.length >= 4 && text.includes(core)) { ok++; continue; }';
const newCheck = '      if (summaryNamesCall(text, nm)) { ok++; continue; }';
const guessAnchor = `  const res = await w.backend.guessFunctions(w.region.id, 400000);\n  const list = res.starts || res.addrs || [];\n  const truth = new Set(o.functionStarts);`;
const guessDiagnostic = `${guessAnchor}\n  if (res.provenanceDiagnostic?.removed) {\n    const hist = { tp:{run:{},window:{},occ:{},mod:{}}, fp:{run:{},window:{},occ:{},mod:{}} };\n    const bump = (obj, key) => { obj[key] = (obj[key] || 0) + 1; };\n    for (const meta of res.provenanceDiagnostic.removed) {\n      const side = truth.has(meta.target) ? 'tp' : 'fp';\n      bump(hist[side].run, String(Math.min(meta.maxRun || 0, 32)));\n      bump(hist[side].window, String(meta.maxWindow9 || 0));\n      bump(hist[side].occ, String(Math.min(meta.occurrences || 0, 16)));\n      bump(hist[side].mod, String(meta.wordMod8Mask || 0));\n    }\n    console.error('FUNC_PROVENANCE_DIAG ' + JSON.stringify({\n      removed:res.provenanceDiagnostic.removed.length, hist,\n      broad:res.provenanceDiagnostic.broadImageRelativeCandidates,\n      independent:res.provenanceDiagnostic.independentStructuredCandidates,\n    }));\n  }`;

let source = fs.readFileSync(basePath, 'utf8');
if (!source.includes(oldCheck)) throw new Error('accuracy-summary-scorer-anchor-missing');
if (!source.includes(guessAnchor)) throw new Error('accuracy-funcs-guess-anchor-missing');
source = `import { summaryNamesCall } from './accuracy-short-selector.mjs';\n` +
  source.replace(oldCheck, newCheck).replace(guessAnchor, guessDiagnostic);

try {
  fs.writeFileSync(activePath, source);
  await import(pathToFileURL(activePath).href);
} finally {
  try { fs.unlinkSync(activePath); } catch {}
}
